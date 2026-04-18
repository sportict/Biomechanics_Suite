#include <algorithm>
#include <chrono>
#include <cmath>
#include <iostream>
#include <napi.h>
#include <opencv2/aruco.hpp>
#include <opencv2/aruco/charuco.hpp>
#include <opencv2/calib3d.hpp>
#include <opencv2/imgproc.hpp>
#include <opencv2/objdetect/aruco_board.hpp>
#include <opencv2/objdetect/charuco_detector.hpp>
#include <opencv2/opencv.hpp>
#include <opencv2/videoio.hpp>
#include <set>
#include <string>
#include <vector>

// マウスイベント用のグローバル変数（制限なし）
struct MouseEventData {
  int x;
  int y;
  bool clicked;
  std::string eventType;
  int clickCount;
};

static MouseEventData g_mouseData;

// VideoCaptureの再利用用グローバル変数
static cv::VideoCapture g_videoCapture;
static std::string g_currentVideoPath;
static int g_lastFrameNumber = -1;

// フレームキャッシュ（動画パス+フレーム番号の複合キーで管理）
static std::map<std::string, cv::Mat> g_frameCache;
static const int CACHE_SIZE = 15;

// Calibration accumulation buffers
static std::vector<std::vector<cv::Point3f>> g_allObjectPoints;
static std::vector<std::vector<cv::Point2f>> g_allImagePoints;
static cv::Size g_calibImageSize;
static std::vector<int> g_cornerCounts;
static std::vector<int> g_markerCounts;
static std::vector<int> g_frameNumbers; // 各サンプルのフレーム番号

// Stereo Charuco calibration buffers (OpenCV stereoCalibrate 用)
// 参照:
// https://docs.opencv.org/4.x/d9/d0c/group__calib3d.html#ga7a824a0b2220a825bbcd8e2b0d72f1b8
static std::vector<std::vector<cv::Point3f>> g_stereoObjectPoints;
static std::vector<std::vector<cv::Point2f>> g_stereoImagePoints1;
static std::vector<std::vector<cv::Point2f>> g_stereoImagePoints2;
static cv::Size g_stereoImageSize;
static cv::Mat g_K1, g_dist1, g_K2, g_dist2;

// ========================================================================================
// 共通ヘルパー関数（重複コード解消）
// ========================================================================================

// ChArUco検出用のチューニング済みパラメータを設定
static void setupCharucoDetectorParams(cv::aruco::DetectorParameters &params) {
  params.adaptiveThreshWinSizeMin = 3;
  params.adaptiveThreshWinSizeMax = 53;
  params.adaptiveThreshWinSizeStep = 4;
  params.cornerRefinementMethod = cv::aruco::CORNER_REFINE_SUBPIX;
  params.cornerRefinementWinSize = 5;
  params.cornerRefinementMaxIterations = 50;
  params.cornerRefinementMinAccuracy = 0.01;
  params.minMarkerPerimeterRate = 0.01;
  params.maxMarkerPerimeterRate = 4.0;
  params.minCornerDistanceRate = 0.02;
  params.minMarkerDistanceRate = 0.02;
  params.polygonalApproxAccuracyRate = 0.05;
  params.maxErroneousBitsInBorderRate = 0.5;
  params.errorCorrectionRate = 0.8;
}

// 辞書名文字列からOpenCV enum値を取得
static int getDictTypeFromName(const std::string &dictName) {
  static const struct { const char *name; int type; } dictMap[] = {
    {"DICT_4X4_50",   cv::aruco::DICT_4X4_50},
    {"DICT_4X4_100",  cv::aruco::DICT_4X4_100},
    {"DICT_4X4_250",  cv::aruco::DICT_4X4_250},
    {"DICT_4X4_1000", cv::aruco::DICT_4X4_1000},
    {"DICT_5X5_50",   cv::aruco::DICT_5X5_50},
    {"DICT_5X5_100",  cv::aruco::DICT_5X5_100},
    {"DICT_5X5_250",  cv::aruco::DICT_5X5_250},
    {"DICT_5X5_1000", cv::aruco::DICT_5X5_1000},
    {"DICT_6X6_50",   cv::aruco::DICT_6X6_50},
    {"DICT_6X6_100",  cv::aruco::DICT_6X6_100},
    {"DICT_6X6_250",  cv::aruco::DICT_6X6_250},
    {"DICT_6X6_1000", cv::aruco::DICT_6X6_1000},
    {"DICT_7X7_50",   cv::aruco::DICT_7X7_50},
    {"DICT_7X7_100",  cv::aruco::DICT_7X7_100},
    {"DICT_7X7_250",  cv::aruco::DICT_7X7_250},
    {"DICT_7X7_1000", cv::aruco::DICT_7X7_1000},
  };
  for (const auto &entry : dictMap) {
    if (dictName == entry.name) return entry.type;
  }
  return cv::aruco::DICT_4X4_50; // デフォルト
}

// boardConfig (Napi::Object) からパラメータを解析
//
// 画像入力は以下の優先順位で使用する（上ほど速い）:
//   1. imageData / imageData1 / imageData2  — Canvas の生ピクセル
//      { width, height, channels, buffer:<Buffer>, stride?: <int> }
//      RGBA(channels=4) / BGR(channels=3) / GRAY(channels=1) を受け付ける
//   2. frameCachePath / frameCachePath1/2  — ディスク上の JPEG/PNG
//   3. videoPath + frameNumber              — 動画からフレーム抽出（最遅）
struct RawImageData {
  const uint8_t *data = nullptr;
  int width = 0;
  int height = 0;
  int channels = 4;   // 4=RGBA, 3=BGR, 1=GRAY
  int stride = 0;     // bytes per row（0 の場合は width*channels）
  bool isValid() const { return data != nullptr && width > 0 && height > 0; }
};

struct CharucoBoardConfig {
  int rows = 5;
  int cols = 7;
  float squareSize = 0.165f;  // meters
  float markerSize = 0.123f;  // meters
  std::string dictName = "DICT_4X4_50";
  std::string frameCachePath;
  std::string frameCachePath1; // ステレオ用
  std::string frameCachePath2; // ステレオ用
  RawImageData rawImage;       // シングル用（高速パス）
  RawImageData rawImage1;      // ステレオ Cam1 用
  RawImageData rawImage2;      // ステレオ Cam2 用
};

// Napi::Object から RawImageData を読み出す
static void parseRawImageData(const Napi::Object &obj, RawImageData &out) {
  if (obj.Has("width") && obj.Get("width").IsNumber())
    out.width = obj.Get("width").As<Napi::Number>().Int32Value();
  if (obj.Has("height") && obj.Get("height").IsNumber())
    out.height = obj.Get("height").As<Napi::Number>().Int32Value();
  if (obj.Has("channels") && obj.Get("channels").IsNumber())
    out.channels = obj.Get("channels").As<Napi::Number>().Int32Value();
  if (obj.Has("stride") && obj.Get("stride").IsNumber())
    out.stride = obj.Get("stride").As<Napi::Number>().Int32Value();
  if (obj.Has("buffer") && obj.Get("buffer").IsBuffer()) {
    Napi::Buffer<uint8_t> buf = obj.Get("buffer").As<Napi::Buffer<uint8_t>>();
    out.data = buf.Data();
  }
}

// RawImageData → cv::Mat（BGR）へ変換
// 成功時は bgr に BGR 画像を格納して true を返す。
// 内部で必ずコピーを行うため、呼び出し側で buffer が解放されても安全。
static bool rawImageToBgr(const RawImageData &raw, cv::Mat &bgr) {
  if (!raw.isValid()) return false;
  int stride = raw.stride > 0 ? raw.stride : raw.width * raw.channels;
  if (raw.channels == 4) {
    cv::Mat rgba(raw.height, raw.width, CV_8UC4, const_cast<uint8_t *>(raw.data), stride);
    cv::cvtColor(rgba, bgr, cv::COLOR_RGBA2BGR);
    return !bgr.empty();
  } else if (raw.channels == 3) {
    cv::Mat m(raw.height, raw.width, CV_8UC3, const_cast<uint8_t *>(raw.data), stride);
    bgr = m.clone();  // 呼び出し側 buffer の寿命から切り離す
    return !bgr.empty();
  } else if (raw.channels == 1) {
    cv::Mat gray(raw.height, raw.width, CV_8UC1, const_cast<uint8_t *>(raw.data), stride);
    cv::cvtColor(gray, bgr, cv::COLOR_GRAY2BGR);
    return !bgr.empty();
  }
  return false;
}

static CharucoBoardConfig parseBoardConfig(const Napi::Object &cfg) {
  CharucoBoardConfig c;
  if (cfg.Has("rows") && cfg.Get("rows").IsNumber())
    c.rows = cfg.Get("rows").As<Napi::Number>().Int32Value();
  if (cfg.Has("cols") && cfg.Get("cols").IsNumber())
    c.cols = cfg.Get("cols").As<Napi::Number>().Int32Value();
  if (cfg.Has("squareSizeMm") && cfg.Get("squareSizeMm").IsNumber())
    c.squareSize = cfg.Get("squareSizeMm").As<Napi::Number>().FloatValue() / 1000.0f;
  if (cfg.Has("markerSizeMm") && cfg.Get("markerSizeMm").IsNumber())
    c.markerSize = cfg.Get("markerSizeMm").As<Napi::Number>().FloatValue() / 1000.0f;
  if (cfg.Has("dictionary") && cfg.Get("dictionary").IsString())
    c.dictName = cfg.Get("dictionary").As<Napi::String>().Utf8Value();
  if (cfg.Has("frameCachePath") && cfg.Get("frameCachePath").IsString())
    c.frameCachePath = cfg.Get("frameCachePath").As<Napi::String>().Utf8Value();
  if (cfg.Has("frameCachePath1") && cfg.Get("frameCachePath1").IsString())
    c.frameCachePath1 = cfg.Get("frameCachePath1").As<Napi::String>().Utf8Value();
  if (cfg.Has("frameCachePath2") && cfg.Get("frameCachePath2").IsString())
    c.frameCachePath2 = cfg.Get("frameCachePath2").As<Napi::String>().Utf8Value();
  if (cfg.Has("imageData") && cfg.Get("imageData").IsObject())
    parseRawImageData(cfg.Get("imageData").As<Napi::Object>(), c.rawImage);
  if (cfg.Has("imageData1") && cfg.Get("imageData1").IsObject())
    parseRawImageData(cfg.Get("imageData1").As<Napi::Object>(), c.rawImage1);
  if (cfg.Has("imageData2") && cfg.Get("imageData2").IsObject())
    parseRawImageData(cfg.Get("imageData2").As<Napi::Object>(), c.rawImage2);
  return c;
}

// グレースケール変換 + CLAHE前処理
static cv::Mat preprocessForCharuco(const cv::Mat &frame) {
  cv::Mat gray;
  if (frame.channels() == 3)
    cv::cvtColor(frame, gray, cv::COLOR_BGR2GRAY);
  else
    gray = frame.clone();
  cv::Ptr<cv::CLAHE> clahe = cv::createCLAHE(2.0, cv::Size(8, 8));
  clahe->apply(gray, gray);
  return gray;
}

// ChArUcoボード生成
static cv::aruco::CharucoBoard createCharucoBoard(
    int cols, int rows, float squareSize, float markerSize,
    const cv::aruco::Dictionary &dictionary) {
  cv::Size boardSize(cols, rows);
#if CV_VERSION_MAJOR >= 4 && CV_VERSION_MINOR >= 6
  cv::aruco::CharucoBoard board(boardSize, squareSize, markerSize, dictionary);
  board.setLegacyPattern(true);
#else
  auto boardPtr = cv::aruco::CharucoBoard::create(
      cols, rows, squareSize, markerSize,
      cv::makePtr<cv::aruco::Dictionary>(dictionary));
  cv::aruco::CharucoBoard board = *boardPtr;
#endif
  return board;
}

// ========================================================================================

// マウスコールバック関数（公式仕様準拠）
// 参照:
// https://docs.opencv.org/4.x/d7/dfc/group__highgui.html#ga89e7806b0a616f6f1d502bd8c183ad3
void mouseCallback(int event, int x, int y, int flags, void *userdata) {
  // 公式ドキュメント: EVENT_LBUTTONDOWN = 1
  // 参照:
  // https://docs.opencv.org/4.x/d7/dfc/group__highgui.html#ga927593befdddc7e7013602bca9b079b
  if (event == cv::EVENT_LBUTTONDOWN) {
    g_mouseData.x = x;
    g_mouseData.y = y;
    g_mouseData.clicked = true;
    g_mouseData.eventType = "LBUTTONDOWN";
    g_mouseData.clickCount++;
  }
}

// Base64 encoding function
std::string base64_encode(const unsigned char *data, size_t length) {
  const std::string base64_chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
                                   "abcdefghijklmnopqrstuvwxyz"
                                   "0123456789+/";

  std::string result;
  for (size_t i = 0; i < length; i += 3) {
    unsigned char b1 = (i < length) ? data[i] : 0;
    unsigned char b2 = (i + 1 < length) ? data[i + 1] : 0;
    unsigned char b3 = (i + 2 < length) ? data[i + 2] : 0;

    unsigned char c1 = (b1 >> 2) & 0x3F;
    unsigned char c2 = ((b1 & 0x03) << 4) | ((b2 >> 4) & 0x0F);
    unsigned char c3 = ((b2 & 0x0F) << 2) | ((b3 >> 6) & 0x03);
    unsigned char c4 = b3 & 0x3F;

    result += base64_chars[c1];
    result += base64_chars[c2];
    result += (i + 1 < length) ? base64_chars[c3] : '=';
    result += (i + 2 < length) ? base64_chars[c4] : '=';
  }
  return result;
}

// Error result creation function
Napi::Object CreateErrorResult(Napi::Env env, const std::string &error) {
  Napi::Object result = Napi::Object::New(env);
  result.Set("success", Napi::Boolean::New(env, false));
  result.Set("error", Napi::String::New(env, error));
  return result;
}

// Extract frame from video（公式仕様準拠）
// 参照: https://docs.opencv.org/4.x/d8/dfe/classcv_1_1VideoCapture.html
Napi::Value ExtractFrame(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();

  if (info.Length() < 2) {
    Napi::TypeError::New(env, "Wrong number of arguments")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  std::string videoPath = info[0].As<Napi::String>();
  int frameNumber = info[1].As<Napi::Number>().Int32Value();

  try {
    // VideoCaptureの再利用
    if (g_currentVideoPath != videoPath) {
      g_videoCapture.release();
      g_videoCapture.open(videoPath);
      g_currentVideoPath = videoPath;
      g_lastFrameNumber = -1;

      // 動画ファイルが変わった場合はキャッシュをクリア
      g_frameCache.clear();
    }

    if (!g_videoCapture.isOpened()) {
      return CreateErrorResult(env, "Failed to open video");
    }

    cv::Mat frame;

    // キャッシュから取得を試行
    const std::string cacheKey = g_currentVideoPath + ":" + std::to_string(frameNumber);
    if (g_frameCache.find(cacheKey) != g_frameCache.end()) {
      frame = g_frameCache[cacheKey];
    } else {
      // 【修正】キャッシュにない場合は常に正確な位置にシークしてから読み込む
      // 59.94fpsのような非整数フレームレートでの精度問題を回避するため
      // OpenCV公式:
      // CAP_PROP_POS_FRAMESによるシークはキーフレームベースで動作する場合があり
      // 非整数フレームレートでは精度が保証されないため、毎回シークを行う
      g_videoCapture.set(cv::CAP_PROP_POS_FRAMES, frameNumber - 1);

      if (!g_videoCapture.read(frame)) {
        return CreateErrorResult(env, "Failed to read frame");
      }

      // read()を呼んだ後の内部位置を記録
      g_lastFrameNumber = frameNumber;

      // キャッシュに保存
      g_frameCache[cacheKey] = frame.clone();

      // キャッシュサイズ管理
      if (g_frameCache.size() > CACHE_SIZE) {
        g_frameCache.erase(g_frameCache.begin());
      }
    }

    std::vector<uchar> buffer;
    cv::imencode(".jpg", frame, buffer, {cv::IMWRITE_JPEG_QUALITY, 95});

    std::string base64String = base64_encode(buffer.data(), buffer.size());

    Napi::Object result = Napi::Object::New(env);
    result.Set("success", Napi::Boolean::New(env, true));
    result.Set("frameData", Napi::String::New(env, base64String));
    result.Set("width", Napi::Number::New(env, frame.cols));
    result.Set("height", Napi::Number::New(env, frame.rows));

    return result;
  } catch (const cv::Exception &e) {
    return CreateErrorResult(env, e.what());
  }
}

// Get video information（公式仕様準拠）
// 参照: https://docs.opencv.org/4.x/d8/dfe/classcv_1_1VideoCapture.html
Napi::Value GetVideoInfo(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1) {
    Napi::TypeError::New(env, "Wrong number of arguments")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  std::string videoPath = info[0].As<Napi::String>();

  try {
    // VideoCaptureの再利用
    if (g_currentVideoPath != videoPath) {
      g_videoCapture.release();
      g_videoCapture.open(videoPath);
      g_currentVideoPath = videoPath;
      g_lastFrameNumber = -1;

      // 動画ファイルが変わった場合はキャッシュをクリア
      g_frameCache.clear();
    }

    if (!g_videoCapture.isOpened()) {
      return CreateErrorResult(env, "Failed to open video");
    }

    // 公式ドキュメント準拠: CAP_PROP_*定数
    double fps = g_videoCapture.get(cv::CAP_PROP_FPS);
    int frameCount =
        static_cast<int>(g_videoCapture.get(cv::CAP_PROP_FRAME_COUNT));
    int width = static_cast<int>(g_videoCapture.get(cv::CAP_PROP_FRAME_WIDTH));
    int height =
        static_cast<int>(g_videoCapture.get(cv::CAP_PROP_FRAME_HEIGHT));
    double duration = frameCount / fps;

    Napi::Object result = Napi::Object::New(env);
    result.Set("fps", Napi::Number::New(env, fps));
    result.Set("frameCount", Napi::Number::New(env, frameCount));
    result.Set("width", Napi::Number::New(env, width));
    result.Set("height", Napi::Number::New(env, height));
    result.Set("duration", Napi::Number::New(env, duration));
    result.Set("success", Napi::Boolean::New(env, true));

    return result;
  } catch (const cv::Exception &e) {
    return CreateErrorResult(env, e.what());
  }
}

// Load image（公式仕様準拠）
// 参照: https://docs.opencv.org/4.x/d3/d63/classcv_1_1Mat.html
Napi::Value LoadImage(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1) {
    Napi::TypeError::New(env, "Wrong number of arguments")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  std::string imagePath = info[0].As<Napi::String>();

  try {
    // 公式ドキュメント準拠: IMREAD_COLOR
    cv::Mat image = cv::imread(imagePath, cv::IMREAD_COLOR);
    if (image.empty()) {
      return CreateErrorResult(env, "Failed to load image");
    }

    Napi::Object result = Napi::Object::New(env);
    result.Set("success", Napi::Boolean::New(env, true));
    result.Set("width", Napi::Number::New(env, image.cols));
    result.Set("height", Napi::Number::New(env, image.rows));
    result.Set("channels", Napi::Number::New(env, image.channels()));
    result.Set("message", Napi::String::New(env, "Image loaded successfully"));

    return result;
  } catch (const cv::Exception &e) {
    return CreateErrorResult(env, e.what());
  }
}

// Process image（公式仕様準拠）
// 参照: https://docs.opencv.org/4.x/d3/d63/classcv_1_1Mat.html
Napi::Value ProcessImage(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1) {
    Napi::TypeError::New(env, "Wrong number of arguments")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  std::string imagePath = info[0].As<Napi::String>();

  try {
    cv::Mat image = cv::imread(imagePath, cv::IMREAD_COLOR);
    if (image.empty()) {
      return CreateErrorResult(env, "Failed to load image");
    }

    // 公式ドキュメント準拠: COLOR_BGR2GRAY
    cv::Mat gray;
    cv::cvtColor(image, gray, cv::COLOR_BGR2GRAY);

    // 公式ドキュメント準拠: GaussianBlur
    cv::Mat blurred;
    cv::GaussianBlur(gray, blurred, cv::Size(5, 5), 0);

    // 公式ドキュメント準拠: Canny
    cv::Mat edges;
    cv::Canny(blurred, edges, 50, 150);

    int edgePixels = cv::countNonZero(edges);

    std::vector<uchar> buffer;
    cv::imencode(".png", edges, buffer);

    std::string base64String = base64_encode(buffer.data(), buffer.size());

    Napi::Object result = Napi::Object::New(env);
    result.Set("success", Napi::Boolean::New(env, true));
    result.Set("originalWidth", Napi::Number::New(env, image.cols));
    result.Set("originalHeight", Napi::Number::New(env, image.rows));
    result.Set("edgePixels", Napi::Number::New(env, edgePixels));
    result.Set("processedImageData", Napi::String::New(env, base64String));
    result.Set("message",
               Napi::String::New(env, "Image processed successfully"));

    return result;
  } catch (const cv::Exception &e) {
    return CreateErrorResult(env, e.what());
  }
}

// Get image coordinates with mouse callback
Napi::Value
GetImageCoordinatesWithMouseCallback(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();

  if (info.Length() < 6) {
    Napi::TypeError::New(env, "Wrong number of arguments")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  std::string videoPath = info[0].As<Napi::String>();
  int frameNumber = info[1].As<Napi::Number>().Int32Value();
  int canvasWidth = info[4].As<Napi::Number>().Int32Value();
  int canvasHeight = info[5].As<Napi::Number>().Int32Value();

  try {
    cv::VideoCapture cap(videoPath);
    if (!cap.isOpened()) {
      return CreateErrorResult(env, "Failed to open video");
    }

    cap.set(cv::CAP_PROP_POS_FRAMES, frameNumber - 1);

    cv::Mat frame;
    if (!cap.read(frame)) {
      return CreateErrorResult(env, "Failed to read frame");
    }

    // ウィンドウを作成してマウスコールバックを設定
    std::string windowName = "Image Coordinates Detection";
    cv::namedWindow(windowName, cv::WINDOW_AUTOSIZE);
    cv::setMouseCallback(windowName, mouseCallback, nullptr);

    // マウスデータをリセット
    g_mouseData.x = 0;
    g_mouseData.y = 0;
    g_mouseData.clicked = false;
    g_mouseData.eventType = "";
    g_mouseData.clickCount = 0;

    // 画像を表示
    cv::imshow(windowName, frame);

    // マウスクリックを待機
    int key;
    while (true) {
      key = cv::waitKey(1); // 1ミリ秒に変更（ほぼ即座のレスポンス）
      if (key == 27 || key == 'q' || key == 'Q') {
        break;
      }
      if (g_mouseData.clicked) {
        break;
      }
    }

    // ウィンドウを閉じる
    cv::destroyWindow(windowName);

    if (!g_mouseData.clicked) {
      return CreateErrorResult(env, "No mouse click detected");
    }

    // 画像サイズを取得（座標変換は不要 -
    // OpenCVのsetMouseCallbackは画像ピクセル座標を直接返す）
    int imageWidth = frame.cols;
    int imageHeight = frame.rows;

    // 生のピクセル座標をそのまま使用（公式ドキュメント準拠）
    int imageX = g_mouseData.x;
    int imageY = g_mouseData.y;

    Napi::Object result = Napi::Object::New(env);
    result.Set("success", Napi::Boolean::New(env, true));

    Napi::Object coordinates = Napi::Object::New(env);
    coordinates.Set("x", Napi::Number::New(env, imageX));
    coordinates.Set("y", Napi::Number::New(env, imageY));
    result.Set("coordinates", coordinates);

    Napi::Object imageSize = Napi::Object::New(env);
    imageSize.Set("width", Napi::Number::New(env, imageWidth));
    imageSize.Set("height", Napi::Number::New(env, imageHeight));
    result.Set("imageSize", imageSize);

    Napi::Object mouseData = Napi::Object::New(env);
    mouseData.Set("rawX", Napi::Number::New(env, g_mouseData.x));
    mouseData.Set("rawY", Napi::Number::New(env, g_mouseData.y));
    mouseData.Set("clickCount", Napi::Number::New(env, g_mouseData.clickCount));
    result.Set("mouseData", mouseData);

    return result;

  } catch (const cv::Exception &e) {
    return CreateErrorResult(env, e.what());
  }
}

// Zoom image
Napi::Value ZoomImage(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();

  if (info.Length() < 3) {
    Napi::TypeError::New(env, "Wrong number of arguments")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  std::string videoPath = info[0].As<Napi::String>();
  int frameNumber = info[1].As<Napi::Number>().Int32Value();
  double zoomScale = info[2].As<Napi::Number>().DoubleValue();

  try {
    // VideoCaptureの再利用
    if (g_currentVideoPath != videoPath) {
      g_videoCapture.release();
      g_videoCapture.open(videoPath);
      g_currentVideoPath = videoPath;
      g_lastFrameNumber = -1;

      // 動画ファイルが変わった場合はキャッシュをクリア
      g_frameCache.clear();
    }

    if (!g_videoCapture.isOpened()) {
      return CreateErrorResult(env, "Failed to open video");
    }

    // フレーム位置設定の最適化（連続フレームの場合はスキップ）
    if (abs(frameNumber - g_lastFrameNumber) > 1) {
      g_videoCapture.set(cv::CAP_PROP_POS_FRAMES, frameNumber - 1);
    }
    g_lastFrameNumber = frameNumber;

    cv::Mat frame;
    if (!g_videoCapture.read(frame)) {
      return CreateErrorResult(env, "Failed to read frame");
    }

    int originalWidth = frame.cols;
    int originalHeight = frame.rows;

    int newWidth = static_cast<int>(originalWidth * zoomScale);
    int newHeight = static_cast<int>(originalHeight * zoomScale);

    // 画像中心をズーム中心として使用
    int imageCenterX = originalWidth / 2;
    int imageCenterY = originalHeight / 2;

    int roiWidth = static_cast<int>(originalWidth / zoomScale);
    int roiHeight = static_cast<int>(originalHeight / zoomScale);

    int roiX = std::max(
        0, std::min(originalWidth - roiWidth, imageCenterX - roiWidth / 2));
    int roiY = std::max(
        0, std::min(originalHeight - roiHeight, imageCenterY - roiHeight / 2));

    cv::Rect roi(roiX, roiY, roiWidth, roiHeight);
    cv::Mat roiImage = frame(roi);

    cv::Mat zoomedImage;
    cv::resize(roiImage, zoomedImage, cv::Size(newWidth, newHeight), 0, 0,
               cv::INTER_LINEAR);

    std::vector<uchar> buffer;
    cv::imencode(".png", zoomedImage, buffer);
    std::string base64String = base64_encode(buffer.data(), buffer.size());

    Napi::Object result = Napi::Object::New(env);
    result.Set("success", Napi::Boolean::New(env, true));
    result.Set("imageData",
               Napi::String::New(env, "data:image/png;base64," + base64String));
    result.Set("width", Napi::Number::New(env, newWidth));
    result.Set("height", Napi::Number::New(env, newHeight));
    result.Set("originalWidth", Napi::Number::New(env, originalWidth));
    result.Set("originalHeight", Napi::Number::New(env, originalHeight));
    result.Set("roiX", Napi::Number::New(env, roiX));
    result.Set("roiY", Napi::Number::New(env, roiY));
    result.Set("roiWidth", Napi::Number::New(env, roiWidth));
    result.Set("roiHeight", Napi::Number::New(env, roiHeight));

    return result;

  } catch (const cv::Exception &e) {
    return CreateErrorResult(env, e.what());
  }
}

// Get zoomed image coordinates
Napi::Value GetZoomedImageCoordinates(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();

  if (info.Length() < 7) {
    Napi::TypeError::New(env, "Wrong number of arguments")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  std::string videoPath = info[0].As<Napi::String>();
  int frameNumber = info[1].As<Napi::Number>().Int32Value();
  int displayX = info[2].As<Napi::Number>().Int32Value();
  int displayY = info[3].As<Napi::Number>().Int32Value();
  double zoomScale = info[4].As<Napi::Number>().DoubleValue();
  int centerX = info[5].As<Napi::Number>().Int32Value();
  int centerY = info[6].As<Napi::Number>().Int32Value();

  try {
    // VideoCaptureの再利用
    if (g_currentVideoPath != videoPath) {
      g_videoCapture.release();
      g_videoCapture.open(videoPath);
      g_currentVideoPath = videoPath;
      g_lastFrameNumber = -1;

      // 動画ファイルが変わった場合はキャッシュをクリア
      g_frameCache.clear();
    }

    if (!g_videoCapture.isOpened()) {
      return CreateErrorResult(env, "Failed to open video");
    }

    // フレーム位置設定の最適化（連続フレームの場合はスキップ）
    if (abs(frameNumber - g_lastFrameNumber) > 1) {
      g_videoCapture.set(cv::CAP_PROP_POS_FRAMES, frameNumber - 1);
    }
    g_lastFrameNumber = frameNumber;

    cv::Mat frame;
    if (!g_videoCapture.read(frame)) {
      return CreateErrorResult(env, "Failed to read frame");
    }

    int originalWidth = frame.cols;
    int originalHeight = frame.rows;

    int newWidth = static_cast<int>(originalWidth * zoomScale);
    int newHeight = static_cast<int>(originalHeight * zoomScale);

    int imageCenterX = static_cast<int>(
        (centerX / static_cast<double>(originalWidth)) * originalWidth);
    int imageCenterY = static_cast<int>(
        (centerY / static_cast<double>(originalHeight)) * originalHeight);

    int roiWidth = static_cast<int>(originalWidth / zoomScale);
    int roiHeight = static_cast<int>(originalHeight / zoomScale);

    int roiX = std::max(
        0, std::min(originalWidth - roiWidth, imageCenterX - roiWidth / 2));
    int roiY = std::max(
        0, std::min(originalHeight - roiHeight, imageCenterY - roiHeight / 2));

    int zoomedX =
        static_cast<int>((displayX / static_cast<double>(newWidth)) * newWidth);
    int zoomedY = static_cast<int>((displayY / static_cast<double>(newHeight)) *
                                   newHeight);

    int originalX = roiX + static_cast<int>(zoomedX / zoomScale);
    int originalY = roiY + static_cast<int>(zoomedY / zoomScale);

    originalX = std::max(0, std::min(originalWidth - 1, originalX));
    originalY = std::max(0, std::min(originalHeight - 1, originalY));

    Napi::Object result = Napi::Object::New(env);
    result.Set("success", Napi::Boolean::New(env, true));

    Napi::Object coordinates = Napi::Object::New(env);
    coordinates.Set("x", Napi::Number::New(env, originalX));
    coordinates.Set("y", Napi::Number::New(env, originalY));
    result.Set("coordinates", coordinates);

    Napi::Object imageSize = Napi::Object::New(env);
    imageSize.Set("width", Napi::Number::New(env, originalWidth));
    imageSize.Set("height", Napi::Number::New(env, originalHeight));
    result.Set("imageSize", imageSize);

    return result;

  } catch (const cv::Exception &e) {
    return CreateErrorResult(env, e.what());
  }
}

// Get display coordinates (fundamental solution)
Napi::Value GetDisplayCoordinates(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();

  if (info.Length() < 11) {
    Napi::TypeError::New(env, "Wrong number of arguments")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  std::string videoPath = info[0].As<Napi::String>();
  int frameNumber = info[1].As<Napi::Number>().Int32Value();
  int mouseX = info[2].As<Napi::Number>().Int32Value();
  int mouseY = info[3].As<Napi::Number>().Int32Value();
  double zoomScale = info[4].As<Napi::Number>().DoubleValue();
  double panX = info[5].As<Napi::Number>().DoubleValue();
  double panY = info[6].As<Napi::Number>().DoubleValue();
  int canvasWidth = info[7].As<Napi::Number>().Int32Value();
  int canvasHeight = info[8].As<Napi::Number>().Int32Value();
  int imageWidth = info[9].As<Napi::Number>().Int32Value();
  int imageHeight = info[10].As<Napi::Number>().Int32Value();

  try {
    cv::VideoCapture cap(videoPath);
    if (!cap.isOpened()) {
      return CreateErrorResult(env, "Failed to open video");
    }

    cap.set(cv::CAP_PROP_POS_FRAMES, frameNumber - 1);

    cv::Mat frame;
    if (!cap.read(frame)) {
      return CreateErrorResult(env, "Failed to read frame");
    }

    int actualImageWidth = frame.cols;
    int actualImageHeight = frame.rows;

    // 変数を関数の先頭で定義
    int imageX, imageY;

    // 画像中心を基準とした単純な座標変換
    // 公式ドキュメント準拠: OpenCV座標系（左上が原点）

    // マウス座標を画像座標に直接変換
    // 1. マウス座標からパンとCanvas中心を引く
    // 2. ズーム倍率で割って1.0倍に戻す
    // 3. 画像中心を足して画像座標に変換
    imageX = static_cast<int>((mouseX - panX - canvasWidth / 2.0) / zoomScale +
                              actualImageWidth / 2.0);
    imageY = static_cast<int>((mouseY - panY - canvasHeight / 2.0) / zoomScale +
                              actualImageHeight / 2.0);

    Napi::Object result = Napi::Object::New(env);
    result.Set("success", Napi::Boolean::New(env, true));

    Napi::Object coordinates = Napi::Object::New(env);
    coordinates.Set("x", Napi::Number::New(env, imageX));
    coordinates.Set("y", Napi::Number::New(env, imageY));
    result.Set("coordinates", coordinates);

    Napi::Object imageSize = Napi::Object::New(env);
    imageSize.Set("width", Napi::Number::New(env, actualImageWidth));
    imageSize.Set("height", Napi::Number::New(env, actualImageHeight));
    result.Set("imageSize", imageSize);

    return result;

  } catch (const cv::Exception &e) {
    return CreateErrorResult(env, e.what());
  }
}

// Get image coordinates with zoom and pan consideration
Napi::Value GetImageCoordinates(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();

  if (!info[0].IsObject()) {
    Napi::TypeError::New(env, "Object expected").ThrowAsJavaScriptException();
    return env.Null();
  }

  Napi::Object params = info[0].As<Napi::Object>();

  double mouseX = params.Get("mouseX").As<Napi::Number>().DoubleValue();
  double mouseY = params.Get("mouseY").As<Napi::Number>().DoubleValue();
  double zoomScale = params.Get("zoomScale").As<Napi::Number>().DoubleValue();
  double panX = params.Get("panX").As<Napi::Number>().DoubleValue();
  double panY = params.Get("panY").As<Napi::Number>().DoubleValue();
  double canvasWidth =
      params.Get("canvasWidth").As<Napi::Number>().DoubleValue();
  double canvasHeight =
      params.Get("canvasHeight").As<Napi::Number>().DoubleValue();
  double imageWidth = params.Get("imageWidth").As<Napi::Number>().DoubleValue();
  double imageHeight =
      params.Get("imageHeight").As<Napi::Number>().DoubleValue();

  try {
    // デバッグ情報を追加
    Napi::Object debugInfo = Napi::Object::New(env);
    debugInfo.Set("inputMouseX", Napi::Number::New(env, mouseX));
    debugInfo.Set("inputMouseY", Napi::Number::New(env, mouseY));
    debugInfo.Set("zoomScale", Napi::Number::New(env, zoomScale));
    debugInfo.Set("panX", Napi::Number::New(env, panX));
    debugInfo.Set("panY", Napi::Number::New(env, panY));
    debugInfo.Set("canvasWidth", Napi::Number::New(env, canvasWidth));
    debugInfo.Set("canvasHeight", Napi::Number::New(env, canvasHeight));
    debugInfo.Set("imageWidth", Napi::Number::New(env, imageWidth));
    debugInfo.Set("imageHeight", Napi::Number::New(env, imageHeight));

    // 画像のピクセル座標を直接計算
    double imgX = (mouseX / canvasWidth) * imageWidth;
    double imgY = (mouseY / canvasHeight) * imageHeight;
    debugInfo.Set("calculatedImageX", Napi::Number::New(env, imgX));
    debugInfo.Set("calculatedImageY", Napi::Number::New(env, imgY));

    // 範囲クランプ
    int px = std::max(0, std::min(static_cast<int>(imageWidth) - 1,
                                  static_cast<int>(std::round(imgX))));
    int py = std::max(0, std::min(static_cast<int>(imageHeight) - 1,
                                  static_cast<int>(std::round(imgY))));
    debugInfo.Set("finalX", Napi::Number::New(env, px));
    debugInfo.Set("finalY", Napi::Number::New(env, py));

    Napi::Object result = Napi::Object::New(env);
    result.Set("success", Napi::Boolean::New(env, true));
    result.Set("x", Napi::Number::New(env, px));
    result.Set("y", Napi::Number::New(env, py));
    result.Set("debug", debugInfo);

    return result;

  } catch (const std::exception &e) {
    return CreateErrorResult(env, e.what());
  }
}

// マウスクリック座標取得関数（公式仕様準拠）
// 参照:
// https://docs.opencv.org/4.x/d7/dfc/group__highgui.html#ga89e7806b0a616f6f1d502bd8c183ad3
Napi::Value GetMouseClickCoordinates(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();

  if (info.Length() < 2) {
    Napi::TypeError::New(env, "Wrong number of arguments")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  std::string videoPath = info[0].As<Napi::String>();
  int frameNumber = info[1].As<Napi::Number>().Int32Value();

  try {
    cv::VideoCapture cap(videoPath);
    if (!cap.isOpened()) {
      return CreateErrorResult(env, "Failed to open video");
    }

    cap.set(cv::CAP_PROP_POS_FRAMES, frameNumber - 1);

    cv::Mat frame;
    if (!cap.read(frame)) {
      return CreateErrorResult(env, "Failed to read frame");
    }

    // 公式ドキュメント準拠: setMouseCallback
    std::string windowName = "Mouse Click Detection";
    cv::namedWindow(windowName, cv::WINDOW_AUTOSIZE);
    cv::setMouseCallback(windowName, mouseCallback, nullptr);

    g_mouseData.x = 0;
    g_mouseData.y = 0;
    g_mouseData.clicked = false;
    g_mouseData.eventType = "";
    g_mouseData.clickCount = 0;
    cv::imshow(windowName, frame);

    int key;
    while (true) {
      key = cv::waitKey(1); // 1ミリ秒に変更（ほぼ即座のレスポンス）
      if (key == 27 || key == 'q' || key == 'Q') {
        break;
      }
      if (g_mouseData.clicked) {
        break;
      }
    }

    cv::destroyWindow(windowName);
    cap.release();

    Napi::Object result = Napi::Object::New(env);
    if (g_mouseData.clicked) {
      result.Set("success", Napi::Boolean::New(env, true));
      result.Set("x", Napi::Number::New(env, g_mouseData.x));
      result.Set("y", Napi::Number::New(env, g_mouseData.y));
      result.Set("eventType", Napi::String::New(env, g_mouseData.eventType));
      result.Set("clickCount", Napi::Number::New(env, g_mouseData.clickCount));
      result.Set(
          "message",
          Napi::String::New(env, "Mouse click detected: " +
                                     std::to_string(g_mouseData.clickCount) +
                                     " clicks"));
    } else {
      result.Set("success", Napi::Boolean::New(env, false));
      result.Set("error", Napi::String::New(env, "No mouse click detected"));
    }

    return result;

  } catch (const cv::Exception &e) {
    return CreateErrorResult(env, e.what());
  }
}

// Charuco検出関数（OpenCV公式ドキュメント準拠＋boardConfig対応）
Napi::Value DetectCharucoBoard(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();

  if (info.Length() < 2) {
    Napi::TypeError::New(env, "Wrong number of arguments")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  std::string videoPath = info[0].As<Napi::String>();
  int frameNumber = info[1].As<Napi::Number>().Int32Value();

  // 3番目の引数からボード設定を取得（任意）
  CharucoBoardConfig bcfg;
  bool isStereo = false;
  if (info.Length() > 2 && info[2].IsObject()) {
    Napi::Object cfg = info[2].As<Napi::Object>();
    bcfg = parseBoardConfig(cfg);
    if (cfg.Has("isStereo") && cfg.Get("isStereo").IsBoolean()) {
      isStereo = cfg.Get("isStereo").As<Napi::Boolean>().Value();
    }
  }
  int rows = bcfg.rows, cols = bcfg.cols;
  float squareSize = bcfg.squareSize, markerSize = bcfg.markerSize;
  const std::string &frameCachePath = bcfg.frameCachePath;
  int dictType = getDictTypeFromName(bcfg.dictName);

  try {
    cv::Mat frame;

    // 画像取得の優先順位:
    //   1. rawImage (Canvas の生ピクセル, JPEG デコード不要 - 最速)
    //   2. frameCachePath (ディスク上の JPEG/PNG)
    //   3. VideoCapture (動画から直接抽出)
    if (rawImageToBgr(bcfg.rawImage, frame)) {
      // 高速パス: 生ピクセルから直接 BGR Mat を構築
    } else if (!frameCachePath.empty()) {
      frame = cv::imread(frameCachePath);
      if (frame.empty()) {
        return CreateErrorResult(env, "Failed to read cached frame image");
      }
    } else {
      if (g_currentVideoPath != videoPath) {
        g_videoCapture.release();
        g_videoCapture.open(videoPath);
        g_currentVideoPath = videoPath;
        g_lastFrameNumber = -1;
        g_frameCache.clear();
      }

      if (!g_videoCapture.isOpened()) {
        return CreateErrorResult(env, "Failed to open video");
      }

      if (g_lastFrameNumber != frameNumber) {
        g_videoCapture.set(cv::CAP_PROP_POS_FRAMES, frameNumber - 1);
        g_lastFrameNumber = frameNumber;
      }

      const std::string cacheKey = g_currentVideoPath + ":" + std::to_string(frameNumber);
      if (g_frameCache.find(cacheKey) != g_frameCache.end()) {
        frame = g_frameCache[cacheKey];
      } else {
        if (!g_videoCapture.read(frame)) {
          return CreateErrorResult(env, "Failed to read frame");
        }
        g_frameCache[cacheKey] = frame.clone();

        if (g_frameCache.size() > CACHE_SIZE) {
          g_frameCache.erase(g_frameCache.begin());
        }
      }
    }

    // 検出結果描画用の画像をコピー
    cv::Mat resultImage;
    frame.copyTo(resultImage);

    // === 分離アプローチ：段階的検出（boardConfigを反映） ===
    // 参照: https://docs.opencv.org/4.x/da/d13/tutorial_aruco_calibration.html

    // 1. ボード／辞書／パラメータ生成（共通ヘルパー使用）
    cv::aruco::Dictionary dictionary =
        cv::aruco::getPredefinedDictionary(dictType);
    cv::aruco::CharucoBoard board =
        createCharucoBoard(cols, rows, squareSize, markerSize, dictionary);

    cv::aruco::DetectorParameters detectorParams;
    setupCharucoDetectorParams(detectorParams);

    // 2. 前処理（グレースケール + CLAHE）
    cv::Mat gray = preprocessForCharuco(frame);

    // === 第1段階：マーカー検出 ===
    std::vector<int> markerIds;
    std::vector<std::vector<cv::Point2f>> markerCorners, rejected;
    cv::aruco::detectMarkers(
        gray, cv::makePtr<cv::aruco::Dictionary>(dictionary), markerCorners,
        markerIds, cv::makePtr<cv::aruco::DetectorParameters>(detectorParams),
        rejected);

    // マーカーをサブピクセル精度で再精査（精度向上）
    if (!markerIds.empty()) {
      cv::aruco::refineDetectedMarkers(
          gray, cv::makePtr<cv::aruco::CharucoBoard>(board), markerCorners,
          markerIds, rejected,
          /*cameraMatrix=*/cv::noArray(),
          /*distCoeffs=*/cv::noArray());
    }

    // === 第2段階：コーナー検出（マーカー結果を使用） ===
    std::vector<cv::Point2f> charucoCorners;
    std::vector<int> charucoIds;

    if (!markerIds.empty()) {
      int detectedCorners = cv::aruco::interpolateCornersCharuco(
          markerCorners, markerIds, gray,
          cv::makePtr<cv::aruco::CharucoBoard>(board), charucoCorners,
          charucoIds);
      (void)detectedCorners;
    }

    // === 内部パラメータが利用可能な場合、solvePnPでtvecを計算 ===
    cv::Mat tvec;
    bool hasTvec = false;
    if (info.Length() > 2 && info[2].IsObject()) {
      Napi::Object cfg = info[2].As<Napi::Object>();
      if (cfg.Has("cameraMatrix") && cfg.Has("distCoeffs") &&
          !charucoCorners.empty() && !charucoIds.empty()) {
        try {
          // cameraMatrixを取得
          Napi::Array KArr = cfg.Get("cameraMatrix").As<Napi::Array>();
          cv::Mat cameraMatrix = cv::Mat::eye(3, 3, CV_64F);
          for (uint32_t i = 0; i < 9 && i < KArr.Length(); ++i) {
            cameraMatrix.at<double>(static_cast<int>(i / 3),
                                    static_cast<int>(i % 3)) =
                KArr.Get(i).As<Napi::Number>().DoubleValue();
          }

          // distCoeffsを取得
          Napi::Array distArr = cfg.Get("distCoeffs").As<Napi::Array>();
          cv::Mat distCoeffs(static_cast<int>(distArr.Length()), 1, CV_64F);
          for (uint32_t i = 0; i < distArr.Length(); ++i) {
            distCoeffs.at<double>(static_cast<int>(i), 0) =
                distArr.Get(i).As<Napi::Number>().DoubleValue();
          }

          // ボードの3D点を取得
          std::vector<cv::Point3f> objectPoints;
          std::vector<cv::Point2f> imagePoints;
          board.matchImagePoints(charucoCorners, charucoIds, objectPoints,
                                 imagePoints);

          // solvePnPでtvecを計算
          if (!objectPoints.empty() && !imagePoints.empty()) {
            cv::Mat rvec;
            bool success = cv::solvePnP(objectPoints, imagePoints, cameraMatrix,
                                        distCoeffs, rvec, tvec);
            if (success) {
              hasTvec = true;
            }
          }
        } catch (const std::exception &e) {
          // エラーが発生しても検出処理は続行
        }
      }
    }

    // === 描画処理 ===

    // 検出されたマーカーを描画（ラベルを大きく）
    if (!markerIds.empty()) {
      // サイズパラメータ（ステレオとシングルで異なる）
      int lineThickness = isStereo ? 4 : 6;
      float fontSize = isStereo ? 2.5f : 3.5f;
      int fontThicknessBg = isStereo ? 8 : 12;
      int fontThicknessFg = isStereo ? 3 : 5;
      int textOffsetX = isStereo ? -20 : -30;
      int textOffsetY = isStereo ? 15 : 20;

      // マーカーの輪郭を描画（緑色）
      for (size_t i = 0; i < markerCorners.size(); i++) {
        const std::vector<cv::Point2f> &corners = markerCorners[i];

        // 4つのコーナーを線で結んで四角形を描画
        for (int j = 0; j < 4; j++) {
          cv::line(resultImage, cv::Point(corners[j].x, corners[j].y),
                   cv::Point(corners[(j + 1) % 4].x, corners[(j + 1) % 4].y),
                   cv::Scalar(0, 255, 0), lineThickness);
        }

        // マーカーIDを大きなフォントで描画（黄色 + 黒縁取り）
        cv::Point2f center(0, 0);
        for (const cv::Point2f &corner : corners) {
          center += corner;
        }
        center *= 0.25f;

        std::string idText = std::to_string(markerIds[i] + 1); // 1から始める
        cv::Point textPos(static_cast<int>(center.x + textOffsetX),
                          static_cast<int>(center.y + textOffsetY));

        // 黒の縁取り（背景として）
        cv::putText(resultImage, idText, textPos, cv::FONT_HERSHEY_SIMPLEX, fontSize,
                    cv::Scalar(0, 0, 0), fontThicknessBg);
        // 黄色のテキスト（前景）
        cv::putText(resultImage, idText, textPos, cv::FONT_HERSHEY_SIMPLEX, fontSize,
                    cv::Scalar(0, 255, 255), fontThicknessFg);
      }
    }

    // 検出されたCharucoコーナーを描画（ラベルを大きく）
    if (!charucoCorners.empty()) {
      // サイズパラメータ（ステレオとシングルで異なる）
      int circleRadiusOuter = isStereo ? 12 : 16;
      int circleRadiusInner = isStereo ? 10 : 14;
      float cornerFontSize = isStereo ? 2.0f : 2.8f;
      int cornerFontThicknessBg = isStereo ? 6 : 9;
      int cornerFontThicknessFg = isStereo ? 3 : 4;
      float cornerTextOffsetX = isStereo ? 15.0f : 20.0f;
      float cornerTextOffsetY = isStereo ? -15.0f : -20.0f;

      for (size_t i = 0; i < charucoCorners.size(); i++) {
        // コーナーを大きなシアン色の円で描画
        cv::circle(resultImage, charucoCorners[i], circleRadiusOuter, cv::Scalar(0, 0, 0),
                   -1); // 黒縁
        cv::circle(resultImage, charucoCorners[i], circleRadiusInner, cv::Scalar(255, 255, 0),
                   -1); // シアン

        // コーナーIDを描画（シアン色 + 黒縁取り）
        cv::Point textPos = charucoCorners[i] + cv::Point2f(cornerTextOffsetX, cornerTextOffsetY);
        std::string idText = std::to_string(charucoIds[i] + 1); // 1から始める

        // 黒の縁取り（背景として）
        cv::putText(resultImage, idText, textPos, cv::FONT_HERSHEY_SIMPLEX, cornerFontSize,
                    cv::Scalar(0, 0, 0), cornerFontThicknessBg);
        // シアンのテキスト（前景）
        cv::putText(resultImage, idText, textPos, cv::FONT_HERSHEY_SIMPLEX, cornerFontSize,
                    cv::Scalar(255, 255, 0), cornerFontThicknessFg);
      }
    }

    // デバッグ文字描画は削除

    // 結果画像をBase64エンコードして返却
    std::vector<uchar> buffer;
    cv::imencode(".jpg", resultImage, buffer, {cv::IMWRITE_JPEG_QUALITY, 95});

    std::string base64String = base64_encode(buffer.data(), buffer.size());

    Napi::Object result = Napi::Object::New(env);
    result.Set("success", Napi::Boolean::New(env, true));
    result.Set("frameData", Napi::String::New(env, base64String));
    result.Set("width", Napi::Number::New(env, resultImage.cols));
    result.Set("height", Napi::Number::New(env, resultImage.rows));
    result.Set("markerCount", Napi::Number::New(env, markerIds.size()));
    result.Set("cornerCount", Napi::Number::New(env, charucoCorners.size()));

    // 追加: 理論最大数（CharucoBoard仕様から算出）
    int maxCorners = (board.getChessboardSize().width - 1) *
                     (board.getChessboardSize().height - 1);
    int maxMarkers = static_cast<int>(board.getIds().size());
    result.Set("maxCornerCount", Napi::Number::New(env, maxCorners));
    result.Set("maxMarkerCount", Napi::Number::New(env, maxMarkers));

    // 追加: 検出Charucoコーナーの座標を返す（カバレッジ・多様性計算用）
    Napi::Array jsCorners = Napi::Array::New(env, charucoCorners.size());
    for (size_t i = 0; i < charucoCorners.size(); ++i) {
      Napi::Object p = Napi::Object::New(env);
      p.Set("x", Napi::Number::New(env, charucoCorners[i].x));
      p.Set("y", Napi::Number::New(env, charucoCorners[i].y));
      jsCorners[i] = p;
    }
    result.Set("charucoCorners", jsCorners);

    // 追加: ID配列（必要ならクライアントで参照可能）
    Napi::Array jsCornerIds = Napi::Array::New(env, charucoIds.size());
    for (size_t i = 0; i < charucoIds.size(); ++i)
      jsCornerIds[i] = Napi::Number::New(env, charucoIds[i]);
    result.Set("charucoIds", jsCornerIds);

    // 追加:
    // マーカーコーナー配列（Charucoコーナーが少ない場合のフォールバックに使用）
    Napi::Array jsMarkerCorners = Napi::Array::New(env, markerCorners.size());
    for (size_t i = 0; i < markerCorners.size(); ++i) {
      const std::vector<cv::Point2f> &mc = markerCorners[i];
      Napi::Array quad = Napi::Array::New(env, mc.size());
      for (size_t k = 0; k < mc.size(); ++k) {
        Napi::Object q = Napi::Object::New(env);
        q.Set("x", Napi::Number::New(env, mc[k].x));
        q.Set("y", Napi::Number::New(env, mc[k].y));
        quad[k] = q;
      }
      jsMarkerCorners[i] = quad;
    }
    result.Set("markerCorners2D", jsMarkerCorners);

    // 追加: tvecが計算できた場合は返す
    if (hasTvec && tvec.rows == 3 && tvec.cols == 1) {
      Napi::Array tvecArr = Napi::Array::New(env, 3);
      for (int i = 0; i < 3; ++i) {
        tvecArr[i] = Napi::Number::New(env, tvec.at<double>(i, 0));
      }
      result.Set("tvec", tvecArr);
    }

    result.Set("debugMessage", Napi::String::New(env, ""));

    return result;

  } catch (const cv::Exception &e) {
    return CreateErrorResult(env, e.what());
  }
}

// Start a new ChArUco calibration session (clear buffers)
Napi::Value StartCharucoCalibrationSession(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  g_allObjectPoints.clear();
  g_allImagePoints.clear();
  g_calibImageSize = cv::Size();
  g_cornerCounts.clear();
  g_markerCounts.clear();
  g_frameNumbers.clear();
  Napi::Object result = Napi::Object::New(env);
  result.Set("success", Napi::Boolean::New(env, true));
  return result;
}

// Capture current frame's ChArUco sample and accumulate points
Napi::Value CaptureCharucoSample(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2) {
    Napi::TypeError::New(env, "Wrong number of arguments")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  std::string videoPath = info[0].As<Napi::String>();
  int frameNumber = info[1].As<Napi::Number>().Int32Value();

  // 3番目の引数からボード設定を取得（共通ヘルパー使用）
  CharucoBoardConfig bcfg;
  if (info.Length() > 2 && info[2].IsObject()) {
    bcfg = parseBoardConfig(info[2].As<Napi::Object>());
  }
  int rows = bcfg.rows, cols = bcfg.cols;
  float squareSize = bcfg.squareSize, markerSize = bcfg.markerSize;
  const std::string &frameCachePath = bcfg.frameCachePath;
  int dictType = getDictTypeFromName(bcfg.dictName);

  try {
    cv::Mat frame;

    // 画像取得の優先順位: rawImage → frameCachePath → VideoCapture
    if (rawImageToBgr(bcfg.rawImage, frame)) {
      // 高速パス
    } else if (!frameCachePath.empty()) {
      frame = cv::imread(frameCachePath);
      if (frame.empty()) {
        return CreateErrorResult(env, "Failed to read cached frame image");
      }
    } else {
      if (g_currentVideoPath != videoPath) {
        g_videoCapture.release();
        g_videoCapture.open(videoPath);
        g_currentVideoPath = videoPath;
        g_lastFrameNumber = -1;
        g_frameCache.clear();
      }
      if (!g_videoCapture.isOpened()) {
        return CreateErrorResult(env, "Failed to open video");
      }
      if (g_lastFrameNumber != frameNumber) {
        g_videoCapture.set(cv::CAP_PROP_POS_FRAMES, frameNumber - 1);
        g_lastFrameNumber = frameNumber;
      }

      const std::string cacheKey = g_currentVideoPath + ":" + std::to_string(frameNumber);
      if (g_frameCache.find(cacheKey) != g_frameCache.end()) {
        frame = g_frameCache[cacheKey];
      } else {
        if (!g_videoCapture.read(frame)) {
          return CreateErrorResult(env, "Failed to read frame");
        }
        g_frameCache[cacheKey] = frame.clone();
        if (static_cast<int>(g_frameCache.size()) > CACHE_SIZE) {
          g_frameCache.erase(g_frameCache.begin());
        }
      }
    }

    // ボード／辞書／パラメータ生成（共通ヘルパー使用）
    cv::aruco::Dictionary dictionary =
        cv::aruco::getPredefinedDictionary(dictType);
    cv::aruco::CharucoBoard board =
        createCharucoBoard(cols, rows, squareSize, markerSize, dictionary);

    cv::aruco::DetectorParameters detectorParams;
    setupCharucoDetectorParams(detectorParams);

    cv::Mat gray = preprocessForCharuco(frame);

    std::vector<int> markerIds;
    std::vector<std::vector<cv::Point2f>> markerCorners, rejected;
    cv::aruco::detectMarkers(
        gray, cv::makePtr<cv::aruco::Dictionary>(dictionary), markerCorners,
        markerIds, cv::makePtr<cv::aruco::DetectorParameters>(detectorParams),
        rejected);

    if (!markerIds.empty()) {
      cv::aruco::refineDetectedMarkers(
          gray, cv::makePtr<cv::aruco::CharucoBoard>(board), markerCorners,
          markerIds, rejected, cv::noArray(), cv::noArray());
    }

    std::vector<cv::Point2f> charucoCorners;
    std::vector<int> charucoIds;
    if (!markerIds.empty()) {
      int detectedCorners = cv::aruco::interpolateCornersCharuco(
          markerCorners, markerIds, gray,
          cv::makePtr<cv::aruco::CharucoBoard>(board), charucoCorners,
          charucoIds);
      (void)detectedCorners;
    }

    std::vector<cv::Point3f> currentObjectPoints;
    std::vector<cv::Point2f> currentImagePoints;

    // OpenCV公式: matchImagePoints 要件 → ids が空でないこと
    if (!charucoCorners.empty() && !charucoIds.empty()) {
      board.matchImagePoints(charucoCorners, charucoIds, currentObjectPoints,
                             currentImagePoints);
    }

    Napi::Object result = Napi::Object::New(env);
    // キャリブレーションには最低6ポイント必要（4はギリギリすぎる）
    const int MIN_POINTS_FOR_CALIBRATION = 6;
    int pointCount = static_cast<int>(currentImagePoints.size());

    if (!currentImagePoints.empty() && !currentObjectPoints.empty() &&
        pointCount >= MIN_POINTS_FOR_CALIBRATION) {
      g_allObjectPoints.push_back(currentObjectPoints);
      g_allImagePoints.push_back(currentImagePoints);
      g_calibImageSize = frame.size();
      g_cornerCounts.push_back(static_cast<int>(charucoCorners.size()));
      g_markerCounts.push_back(static_cast<int>(markerIds.size()));
      g_frameNumbers.push_back(frameNumber); // フレーム番号を保存
      result.Set("success", Napi::Boolean::New(env, true));
      result.Set(
          "samples",
          Napi::Number::New(env, static_cast<int>(g_allImagePoints.size())));
      result.Set("points", Napi::Number::New(env, pointCount));
    } else {
      // デバッグ情報を追加
      std::string debugMsg =
          "markers: " + std::to_string(markerIds.size()) +
          ", charucoCorners: " + std::to_string(charucoCorners.size()) +
          ", charucoIds: " + std::to_string(charucoIds.size()) +
          ", matchedPoints: " + std::to_string(currentImagePoints.size()) +
          ", frameSize: " + std::to_string(frame.cols) + "x" +
          std::to_string(frame.rows) +
          ", minRequired: " + std::to_string(MIN_POINTS_FOR_CALIBRATION);
      result.Set("success", Napi::Boolean::New(env, false));
      result.Set(
          "error",
          Napi::String::New(
              env, pointCount > 0 && pointCount < MIN_POINTS_FOR_CALIBRATION
                       ? "Not enough points (need at least 6)"
                       : "No valid ChArUco points in this frame"));
      result.Set("debug", Napi::String::New(env, debugMsg));
      result.Set("detectedPoints", Napi::Number::New(env, pointCount));
    }
    return result;
  } catch (const cv::Exception &e) {
    return CreateErrorResult(env, e.what());
  }
}

// Compute camera calibration from accumulated samples
Napi::Value ComputeCharucoCalibration(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  try {
    if (g_allImagePoints.empty() || g_allObjectPoints.empty()) {
      return CreateErrorResult(env, "No samples captured");
    }
    cv::Mat cameraMatrix, distCoeffs;
    std::vector<cv::Mat> rvecs, tvecs;
    int flags = 0; // can be parameterized later
    double repError = cv::calibrateCamera(
        g_allObjectPoints, g_allImagePoints, g_calibImageSize, cameraMatrix,
        distCoeffs, rvecs, tvecs, // collect extrinsics
        cv::noArray(), cv::noArray(), cv::noArray(), flags);

    Napi::Object result = Napi::Object::New(env);
    result.Set("success", Napi::Boolean::New(env, true));
    result.Set("reprojectionError", Napi::Number::New(env, repError));

    // cameraMatrix 3x3
    Napi::Array cam = Napi::Array::New(env, 9);
    for (int r = 0; r < 3; ++r) {
      for (int c = 0; c < 3; ++c) {
        cam[r * 3 + c] = Napi::Number::New(env, cameraMatrix.at<double>(r, c));
      }
    }
    result.Set("cameraMatrix", cam);

    // distCoeffs (variable length)
    Napi::Array dist = Napi::Array::New(env, distCoeffs.total());
    for (size_t i = 0; i < distCoeffs.total(); ++i) {
      dist[i] =
          Napi::Number::New(env, distCoeffs.at<double>(static_cast<int>(i)));
    }
    result.Set("distCoeffs", dist);
    result.Set("samples", Napi::Number::New(
                              env, static_cast<int>(g_allImagePoints.size())));

    // フレーム番号を返す
    Napi::Array frameNums = Napi::Array::New(env, g_frameNumbers.size());
    for (size_t i = 0; i < g_frameNumbers.size(); ++i) {
      frameNums[i] = Napi::Number::New(env, g_frameNumbers[i]);
    }
    result.Set("frameNumbers", frameNums);

    // rvecs/tvecs and rotation matrices
    Napi::Array rArr = Napi::Array::New(env, rvecs.size());
    Napi::Array tArr = Napi::Array::New(env, tvecs.size());
    Napi::Array RArr = Napi::Array::New(env, rvecs.size());
    Napi::Array viewErr = Napi::Array::New(env, rvecs.size());
    for (size_t i = 0; i < rvecs.size(); ++i) {
      // rvec (3)
      Napi::Array rv = Napi::Array::New(env, 3);
      for (int k = 0; k < 3; ++k) {
        rv[k] = Napi::Number::New(env, rvecs[i].at<double>(k));
      }
      rArr[i] = rv;

      // tvec (3)
      Napi::Array tv = Napi::Array::New(env, 3);
      for (int k = 0; k < 3; ++k) {
        tv[k] = Napi::Number::New(env, tvecs[i].at<double>(k));
      }
      tArr[i] = tv;

      // Rotation matrix (3x3) from rvec
      cv::Mat R;
      cv::Rodrigues(rvecs[i], R);
      Napi::Array Ra = Napi::Array::New(env, 9);
      for (int r = 0; r < 3; ++r) {
        for (int c = 0; c < 3; ++c) {
          Ra[r * 3 + c] = Napi::Number::New(env, R.at<double>(r, c));
        }
      }
      RArr[i] = Ra;

      // Per-view reprojection error (RMS)
      std::vector<cv::Point2f> projected;
      cv::projectPoints(g_allObjectPoints[i], rvecs[i], tvecs[i], cameraMatrix,
                        distCoeffs, projected);
      const std::vector<cv::Point2f> &observed = g_allImagePoints[i];
      double errSum = 0.0;
      size_t npts = std::min(projected.size(), observed.size());
      for (size_t p = 0; p < npts; ++p) {
        double dx = static_cast<double>(projected[p].x - observed[p].x);
        double dy = static_cast<double>(projected[p].y - observed[p].y);
        errSum += dx * dx + dy * dy;
      }
      double rms = npts > 0 ? std::sqrt(errSum / npts) : 0.0;
      viewErr[i] = Napi::Number::New(env, rms);
    }
    result.Set("rvecs", rArr);
    result.Set("tvecs", tArr);
    result.Set("rotationMatrices", RArr);
    result.Set("viewErrors", viewErr);
    // counts per view (for UI tables)
    Napi::Array cornerArr = Napi::Array::New(env, g_cornerCounts.size());
    Napi::Array markerArr = Napi::Array::New(env, g_markerCounts.size());
    for (size_t i = 0; i < g_cornerCounts.size(); ++i)
      cornerArr[i] = Napi::Number::New(env, g_cornerCounts[i]);
    for (size_t i = 0; i < g_markerCounts.size(); ++i)
      markerArr[i] = Napi::Number::New(env, g_markerCounts[i]);
    result.Set("cornerCounts", cornerArr);
    result.Set("markerCounts", markerArr);

    // 点群データを追加（保存・復元用）
    // allImagePoints: 各ビューの画像座標
    Napi::Array allImgPts = Napi::Array::New(env, g_allImagePoints.size());
    for (size_t v = 0; v < g_allImagePoints.size(); ++v) {
      const std::vector<cv::Point2f> &pts = g_allImagePoints[v];
      Napi::Array viewPts = Napi::Array::New(env, pts.size());
      for (size_t p = 0; p < pts.size(); ++p) {
        Napi::Object pt = Napi::Object::New(env);
        pt.Set("x", Napi::Number::New(env, pts[p].x));
        pt.Set("y", Napi::Number::New(env, pts[p].y));
        viewPts[p] = pt;
      }
      allImgPts[v] = viewPts;
    }
    result.Set("allImagePoints", allImgPts);

    // allObjectPoints: 各ビューの3D座標
    Napi::Array allObjPts = Napi::Array::New(env, g_allObjectPoints.size());
    for (size_t v = 0; v < g_allObjectPoints.size(); ++v) {
      const std::vector<cv::Point3f> &pts = g_allObjectPoints[v];
      Napi::Array viewPts = Napi::Array::New(env, pts.size());
      for (size_t p = 0; p < pts.size(); ++p) {
        Napi::Object pt = Napi::Object::New(env);
        pt.Set("x", Napi::Number::New(env, pts[p].x));
        pt.Set("y", Napi::Number::New(env, pts[p].y));
        pt.Set("z", Napi::Number::New(env, pts[p].z));
        viewPts[p] = pt;
      }
      allObjPts[v] = viewPts;
    }
    result.Set("allObjectPoints", allObjPts);

    // 画像サイズ
    result.Set("imageWidth", Napi::Number::New(env, g_calibImageSize.width));
    result.Set("imageHeight", Napi::Number::New(env, g_calibImageSize.height));

    return result;
  } catch (const cv::Exception &e) {
    return CreateErrorResult(env, e.what());
  }
}

// Compute camera calibration from accumulated samples, excluding specified
// views 公式: calibrateCamera
// https://docs.opencv.org/4.x/d9/d0c/group__calib3d.html#ga2e9f0f7dd2a140b1e2c4e5f6d2d5d7d1
Napi::Value
ComputeCharucoCalibrationWithExclusions(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();

  // 0番目の引数に除外ビューインデックス配列（任意）
  std::set<int> exclude;
  if (info.Length() > 0 && info[0].IsArray()) {
    Napi::Array exArr = info[0].As<Napi::Array>();
    for (uint32_t i = 0; i < exArr.Length(); ++i) {
      if (!exArr.Get(i).IsNumber())
        continue;
      int idx = exArr.Get(i).As<Napi::Number>().Int32Value();
      if (idx >= 0)
        exclude.insert(idx);
    }
  }

  try {
    if (g_allImagePoints.empty() || g_allObjectPoints.empty()) {
      return CreateErrorResult(env, "No samples captured");
    }

    // 除外ビューを考慮してサンプルをフィルタリング
    std::vector<std::vector<cv::Point3f>> objPts;
    std::vector<std::vector<cv::Point2f>> imgPts;
    std::vector<int> cornerCountsFiltered;
    std::vector<int> markerCountsFiltered;
    std::vector<int> frameNumbersFiltered;
    std::vector<int> originalIndicesFiltered; // 元の g_allImagePoints インデックス

    for (size_t i = 0; i < g_allObjectPoints.size(); ++i) {
      if (exclude.count(static_cast<int>(i)) > 0)
        continue;
      objPts.push_back(g_allObjectPoints[i]);
      imgPts.push_back(g_allImagePoints[i]);
      if (i < g_cornerCounts.size())
        cornerCountsFiltered.push_back(g_cornerCounts[i]);
      if (i < g_markerCounts.size())
        markerCountsFiltered.push_back(g_markerCounts[i]);
      if (i < g_frameNumbers.size())
        frameNumbersFiltered.push_back(g_frameNumbers[i]);
      originalIndicesFiltered.push_back(static_cast<int>(i));
    }

    if (objPts.empty() || imgPts.empty()) {
      return CreateErrorResult(env, "All samples are excluded");
    }

    cv::Mat cameraMatrix, distCoeffs;
    std::vector<cv::Mat> rvecs, tvecs;
    int flags = 0;
    double repError = cv::calibrateCamera(
        objPts, imgPts, g_calibImageSize, cameraMatrix, distCoeffs, rvecs,
        tvecs, cv::noArray(), cv::noArray(), cv::noArray(), flags);

    Napi::Object result = Napi::Object::New(env);
    result.Set("success", Napi::Boolean::New(env, true));
    result.Set("reprojectionError", Napi::Number::New(env, repError));

    // cameraMatrix 3x3
    Napi::Array cam = Napi::Array::New(env, 9);
    for (int r = 0; r < 3; ++r) {
      for (int c = 0; c < 3; ++c) {
        cam[r * 3 + c] = Napi::Number::New(env, cameraMatrix.at<double>(r, c));
      }
    }
    result.Set("cameraMatrix", cam);

    // distCoeffs
    Napi::Array dist = Napi::Array::New(env, distCoeffs.total());
    for (size_t i = 0; i < distCoeffs.total(); ++i) {
      dist[i] =
          Napi::Number::New(env, distCoeffs.at<double>(static_cast<int>(i)));
    }
    result.Set("distCoeffs", dist);
    result.Set("samples",
               Napi::Number::New(env, static_cast<int>(imgPts.size())));

    // rvecs/tvecs, rotation matrices, viewErrors
    Napi::Array rArr = Napi::Array::New(env, rvecs.size());
    Napi::Array tArr = Napi::Array::New(env, tvecs.size());
    Napi::Array RArr = Napi::Array::New(env, rvecs.size());
    Napi::Array viewErr = Napi::Array::New(env, rvecs.size());

    for (size_t i = 0; i < rvecs.size(); ++i) {
      Napi::Array rv = Napi::Array::New(env, 3);
      for (int k = 0; k < 3; ++k) {
        rv[k] = Napi::Number::New(env, rvecs[i].at<double>(k));
      }
      rArr[i] = rv;

      Napi::Array tv = Napi::Array::New(env, 3);
      for (int k = 0; k < 3; ++k) {
        tv[k] = Napi::Number::New(env, tvecs[i].at<double>(k));
      }
      tArr[i] = tv;

      cv::Mat R;
      cv::Rodrigues(rvecs[i], R);
      Napi::Array Ra = Napi::Array::New(env, 9);
      for (int r = 0; r < 3; ++r) {
        for (int c = 0; c < 3; ++c) {
          Ra[r * 3 + c] = Napi::Number::New(env, R.at<double>(r, c));
        }
      }
      RArr[i] = Ra;

      std::vector<cv::Point2f> projected;
      cv::projectPoints(objPts[i], rvecs[i], tvecs[i], cameraMatrix, distCoeffs,
                        projected);
      const std::vector<cv::Point2f> &observed = imgPts[i];
      double errSum = 0.0;
      size_t npts = std::min(projected.size(), observed.size());
      for (size_t p = 0; p < npts; ++p) {
        double dx = static_cast<double>(projected[p].x - observed[p].x);
        double dy = static_cast<double>(projected[p].y - observed[p].y);
        errSum += dx * dx + dy * dy;
      }
      double rms = npts > 0 ? std::sqrt(errSum / npts) : 0.0;
      viewErr[i] = Napi::Number::New(env, rms);
    }

    result.Set("rvecs", rArr);
    result.Set("tvecs", tArr);
    result.Set("rotationMatrices", RArr);
    result.Set("viewErrors", viewErr);

    // counts per view (フィルタ済み)
    Napi::Array cornerArr = Napi::Array::New(env, cornerCountsFiltered.size());
    Napi::Array markerArr = Napi::Array::New(env, markerCountsFiltered.size());
    for (size_t i = 0; i < cornerCountsFiltered.size(); ++i) {
      cornerArr[i] = Napi::Number::New(env, cornerCountsFiltered[i]);
    }
    for (size_t i = 0; i < markerCountsFiltered.size(); ++i) {
      markerArr[i] = Napi::Number::New(env, markerCountsFiltered[i]);
    }
    result.Set("cornerCounts", cornerArr);
    result.Set("markerCounts", markerArr);

    // フレーム番号(フィルタ済み): フロントエンド側がビュー→フレーム対応を表示するのに必要
    Napi::Array fnArr = Napi::Array::New(env, frameNumbersFiltered.size());
    for (size_t i = 0; i < frameNumbersFiltered.size(); ++i) {
      fnArr[i] = Napi::Number::New(env, frameNumbersFiltered[i]);
    }
    result.Set("frameNumbers", fnArr);

    // 元の g_allImagePoints におけるインデックス (除外累積対応)
    // フロントエンドは「現在のビュー番号 → 元サンプル番号」のマップとして利用
    Napi::Array oiArr = Napi::Array::New(env, originalIndicesFiltered.size());
    for (size_t i = 0; i < originalIndicesFiltered.size(); ++i) {
      oiArr[i] = Napi::Number::New(env, originalIndicesFiltered[i]);
    }
    result.Set("originalIndices", oiArr);
    return result;
  } catch (const cv::Exception &e) {
    return CreateErrorResult(env, e.what());
  }
}

// ============================
// Restore Calibration Buffers (for exclusion recalculation from saved data)
// ============================
Napi::Value RestoreCalibrationBuffers(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsObject()) {
    return CreateErrorResult(env, "Invalid arguments: expected object with "
                                  "allImagePoints, allObjectPoints, imageSize");
  }

  Napi::Object params = info[0].As<Napi::Object>();

  try {
    // Clear existing buffers
    g_allObjectPoints.clear();
    g_allImagePoints.clear();
    g_cornerCounts.clear();
    g_markerCounts.clear();
    g_frameNumbers.clear();

    // Restore imageSize
    if (params.Has("imageWidth") && params.Has("imageHeight")) {
      int w = params.Get("imageWidth").As<Napi::Number>().Int32Value();
      int h = params.Get("imageHeight").As<Napi::Number>().Int32Value();
      g_calibImageSize = cv::Size(w, h);
    }

    // Restore allImagePoints (array of arrays of {x, y})
    if (params.Has("allImagePoints") &&
        params.Get("allImagePoints").IsArray()) {
      Napi::Array views = params.Get("allImagePoints").As<Napi::Array>();
      for (uint32_t v = 0; v < views.Length(); ++v) {
        if (!views.Get(v).IsArray())
          continue;
        Napi::Array pts = views.Get(v).As<Napi::Array>();
        std::vector<cv::Point2f> imgPts;
        for (uint32_t p = 0; p < pts.Length(); ++p) {
          if (!pts.Get(p).IsObject())
            continue;
          Napi::Object pt = pts.Get(p).As<Napi::Object>();
          float x = pt.Get("x").As<Napi::Number>().FloatValue();
          float y = pt.Get("y").As<Napi::Number>().FloatValue();
          imgPts.push_back(cv::Point2f(x, y));
        }
        g_allImagePoints.push_back(imgPts);
      }
    }

    // Restore allObjectPoints (array of arrays of {x, y, z})
    if (params.Has("allObjectPoints") &&
        params.Get("allObjectPoints").IsArray()) {
      Napi::Array views = params.Get("allObjectPoints").As<Napi::Array>();
      for (uint32_t v = 0; v < views.Length(); ++v) {
        if (!views.Get(v).IsArray())
          continue;
        Napi::Array pts = views.Get(v).As<Napi::Array>();
        std::vector<cv::Point3f> objPts;
        for (uint32_t p = 0; p < pts.Length(); ++p) {
          if (!pts.Get(p).IsObject())
            continue;
          Napi::Object pt = pts.Get(p).As<Napi::Object>();
          float x = pt.Get("x").As<Napi::Number>().FloatValue();
          float y = pt.Get("y").As<Napi::Number>().FloatValue();
          float z = pt.Get("z").As<Napi::Number>().FloatValue();
          objPts.push_back(cv::Point3f(x, y, z));
        }
        g_allObjectPoints.push_back(objPts);
      }
    }

    // Restore cornerCounts
    if (params.Has("cornerCounts") && params.Get("cornerCounts").IsArray()) {
      Napi::Array arr = params.Get("cornerCounts").As<Napi::Array>();
      for (uint32_t i = 0; i < arr.Length(); ++i) {
        g_cornerCounts.push_back(arr.Get(i).As<Napi::Number>().Int32Value());
      }
    }

    // Restore markerCounts
    if (params.Has("markerCounts") && params.Get("markerCounts").IsArray()) {
      Napi::Array arr = params.Get("markerCounts").As<Napi::Array>();
      for (uint32_t i = 0; i < arr.Length(); ++i) {
        g_markerCounts.push_back(arr.Get(i).As<Napi::Number>().Int32Value());
      }
    }

    // Restore frameNumbers
    if (params.Has("frameNumbers") && params.Get("frameNumbers").IsArray()) {
      Napi::Array arr = params.Get("frameNumbers").As<Napi::Array>();
      for (uint32_t i = 0; i < arr.Length(); ++i) {
        g_frameNumbers.push_back(arr.Get(i).As<Napi::Number>().Int32Value());
      }
    }

    Napi::Object result = Napi::Object::New(env);
    result.Set("success", Napi::Boolean::New(env, true));
    result.Set(
        "restoredViews",
        Napi::Number::New(env, static_cast<int>(g_allImagePoints.size())));
    return result;
  } catch (const std::exception &e) {
    return CreateErrorResult(env, e.what());
  }
}

// ============================
// Stereo Charuco Calibration
// ============================
// 参考: ユーザー提供ドキュメントおよび OpenCV 公式 stereoCalibrate
// https://docs.opencv.org/4.x/d9/d0c/group__calib3d.html#ga7a824a0b2220a825bbcd8e2b0d72f1b8

// Start stereo session: receive fixed intrinsics (CALIB_FIX_INTRINSIC 用)
// 引数はオプション：内部パラメータがない場合はステレオキャリブレーション時に同時推定
// 参照:
// https://docs.opencv.org/4.x/d9/d0c/group__calib3d.html#ga91018d80e2a93ade37539f01e6f07de5
Napi::Value
StartCharucoStereoCalibrationSession(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();

  // バッファをクリア
  g_stereoObjectPoints.clear();
  g_stereoImagePoints1.clear();
  g_stereoImagePoints2.clear();
  g_stereoImageSize = cv::Size();
  g_K1.release();
  g_K2.release();
  g_dist1.release();
  g_dist2.release();

  // 内部パラメータがある場合のみ読み込み（オプション）
  bool hasIntrinsics = false;
  if (info.Length() >= 4 && info[0].IsArray() && info[1].IsArray() &&
      info[2].IsArray() && info[3].IsArray()) {

    Napi::Array k1Arr = info[0].As<Napi::Array>();
    Napi::Array d1Arr = info[1].As<Napi::Array>();
    Napi::Array k2Arr = info[2].As<Napi::Array>();
    Napi::Array d2Arr = info[3].As<Napi::Array>();

    // K1, K2 が有効な場合のみ設定（長さ9以上の配列）
    if (k1Arr.Length() >= 9 && k2Arr.Length() >= 9) {
      g_K1 = cv::Mat::eye(3, 3, CV_64F);
      g_K2 = cv::Mat::eye(3, 3, CV_64F);
      g_dist1 = cv::Mat::zeros(static_cast<int>(d1Arr.Length()), 1, CV_64F);
      g_dist2 = cv::Mat::zeros(static_cast<int>(d2Arr.Length()), 1, CV_64F);

      // cameraMatrix 3x3 を一次元配列(長さ9)から復元
      for (uint32_t i = 0; i < 9 && i < k1Arr.Length(); ++i) {
        g_K1.at<double>(static_cast<int>(i / 3), static_cast<int>(i % 3)) =
            k1Arr.Get(i).As<Napi::Number>().DoubleValue();
      }
      for (uint32_t i = 0; i < 9 && i < k2Arr.Length(); ++i) {
        g_K2.at<double>(static_cast<int>(i / 3), static_cast<int>(i % 3)) =
            k2Arr.Get(i).As<Napi::Number>().DoubleValue();
      }
      for (uint32_t i = 0; i < d1Arr.Length(); ++i) {
        g_dist1.at<double>(static_cast<int>(i), 0) =
            d1Arr.Get(i).As<Napi::Number>().DoubleValue();
      }
      for (uint32_t i = 0; i < d2Arr.Length(); ++i) {
        g_dist2.at<double>(static_cast<int>(i), 0) =
            d2Arr.Get(i).As<Napi::Number>().DoubleValue();
      }
      hasIntrinsics = true;
    }
  }

  Napi::Object result = Napi::Object::New(env);
  result.Set("success", Napi::Boolean::New(env, true));
  result.Set("hasIntrinsics", Napi::Boolean::New(env, hasIntrinsics));
  return result;
}

// Capture stereo sample: 同期フレームから共通IDのChArUco点を抽出し蓄積
Napi::Value CaptureCharucoStereoSample(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 4) {
    Napi::TypeError::New(
        env, "Expected videoPath1, videoPath2, frameNumber, boardConfig")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  std::string videoPath1 = info[0].As<Napi::String>();
  std::string videoPath2 = info[1].As<Napi::String>();
  int frameNumber = info[2].As<Napi::Number>().Int32Value();
  Napi::Object cfg = info[3].As<Napi::Object>();

  // ボード設定解析（共通ヘルパー使用）
  CharucoBoardConfig bcfg = parseBoardConfig(cfg);
  int dictType = getDictTypeFromName(bcfg.dictName);

  try {
    cv::aruco::Dictionary dictionary =
        cv::aruco::getPredefinedDictionary(dictType);
    cv::aruco::CharucoBoard board = createCharucoBoard(
        bcfg.cols, bcfg.rows, bcfg.squareSize, bcfg.markerSize, dictionary);

    cv::aruco::DetectorParameters detectorParams;
    setupCharucoDetectorParams(detectorParams);

    auto grabCharuco =
        [&](const std::string &path, const std::string &cachePath,
            const RawImageData &rawImg,
            std::vector<cv::Point3f> &objPts, std::vector<cv::Point2f> &imgPts,
            std::vector<int> &idsOut) -> bool {
      cv::Mat frame;

      // 画像取得の優先順位: rawImg → cachePath → VideoCapture
      if (rawImageToBgr(rawImg, frame)) {
        // 高速パス
      } else if (!cachePath.empty()) {
        frame = cv::imread(cachePath);
        if (frame.empty())
          return false;
      } else {
        cv::VideoCapture cap(path);
        if (!cap.isOpened())
          return false;
        cap.set(cv::CAP_PROP_POS_FRAMES, frameNumber - 1);
        if (!cap.read(frame) || frame.empty())
          return false;
      }
      if (g_stereoImageSize.width == 0 || g_stereoImageSize.height == 0) {
        g_stereoImageSize = frame.size();
      }
      cv::Mat gray = preprocessForCharuco(frame);

      // === チューニング済み検出ロジック ===
      // 第1段階：マーカー検出
      std::vector<int> markerIds;
      std::vector<std::vector<cv::Point2f>> markerCorners, rejected;
      cv::aruco::detectMarkers(
          gray, cv::makePtr<cv::aruco::Dictionary>(dictionary), markerCorners,
          markerIds, cv::makePtr<cv::aruco::DetectorParameters>(detectorParams),
          rejected);

      // マーカーをサブピクセル精度で再精査
      if (!markerIds.empty()) {
        cv::aruco::refineDetectedMarkers(
            gray, cv::makePtr<cv::aruco::CharucoBoard>(board), markerCorners,
            markerIds, rejected,
            /*cameraMatrix=*/cv::noArray(),
            /*distCoeffs=*/cv::noArray());
      }

      // 第2段階：コーナー検出（マーカー結果を使用）
      std::vector<cv::Point2f> charucoCorners;
      std::vector<int> charucoIds;

      if (!markerIds.empty()) {
        int detectedCorners = cv::aruco::interpolateCornersCharuco(
            markerCorners, markerIds, gray,
            cv::makePtr<cv::aruco::CharucoBoard>(board), charucoCorners,
            charucoIds);
        (void)detectedCorners;
      }

      if (charucoIds.empty())
        return false;

      board.matchImagePoints(charucoCorners, charucoIds, objPts, imgPts);
      idsOut = charucoIds;
      return !objPts.empty() && !imgPts.empty();
    };

    std::vector<cv::Point3f> obj1, obj2;
    std::vector<cv::Point2f> pts1, pts2;
    std::vector<int> ids1, ids2;

    if (!grabCharuco(videoPath1, bcfg.frameCachePath1, bcfg.rawImage1, obj1, pts1, ids1) ||
        !grabCharuco(videoPath2, bcfg.frameCachePath2, bcfg.rawImage2, obj2, pts2, ids2)) {
      Napi::Object res = Napi::Object::New(env);
      res.Set("success", Napi::Boolean::New(env, false));
      res.Set("error",
              Napi::String::New(env, "Failed to detect ChArUco in both views"));
      return res;
    }

    std::set<int> set1(ids1.begin(), ids1.end());
    std::set<int> set2(ids2.begin(), ids2.end());
    std::vector<int> commonIds;
    std::set_intersection(set1.begin(), set1.end(), set2.begin(), set2.end(),
                          std::back_inserter(commonIds));

    // Debug: Log the sizes and IDs (最初のエラーチェックでも使用)
    std::string debugMsg =
        "Debug: ids1.size()=" + std::to_string(ids1.size()) +
        ", ids2.size()=" + std::to_string(ids2.size()) +
        ", commonIds.size()=" + std::to_string(commonIds.size()) + ", ids1: [";
    for (size_t i = 0; i < ids1.size(); ++i) {
      debugMsg += std::to_string(ids1[i]);
      if (i < ids1.size() - 1)
        debugMsg += ",";
    }
    debugMsg += "], ids2: [";
    for (size_t i = 0; i < ids2.size(); ++i) {
      debugMsg += std::to_string(ids2[i]);
      if (i < ids2.size() - 1)
        debugMsg += ",";
    }
    debugMsg += "]";

    if (static_cast<int>(commonIds.size()) < 6) {
      Napi::Object res = Napi::Object::New(env);
      res.Set("success", Napi::Boolean::New(env, false));
      std::string errorMsg = "Not enough common ChArUco corners (detected: " +
                             std::to_string(commonIds.size()) +
                             ", required: 6). " + debugMsg;
      res.Set("error", Napi::String::New(env, errorMsg));
      // デバッグ/オーバーレイ用に共通ID数を返す
      res.Set("commonCount",
              Napi::Number::New(env, static_cast<int>(commonIds.size())));
      return res;
    }

    std::vector<cv::Point3f> allCorners3D = board.getChessboardCorners();
    std::vector<cv::Point3f> commonObj;
    std::vector<cv::Point2f> commonPts1, commonPts2;

    // Debug: 追加情報（allCorners3Dのサイズ）
    debugMsg += ", allCorners3D.size()=" + std::to_string(allCorners3D.size());

    for (int cid : commonIds) {
      auto it1 = std::find(ids1.begin(), ids1.end(), cid);
      auto it2 = std::find(ids2.begin(), ids2.end(), cid);
      if (it1 == ids1.end() || it2 == ids2.end())
        continue;
      int idx1 = static_cast<int>(std::distance(ids1.begin(), it1));
      int idx2 = static_cast<int>(std::distance(ids2.begin(), it2));
      if (cid >= 0 && cid < static_cast<int>(allCorners3D.size())) {
        commonObj.push_back(allCorners3D[cid]);
        commonPts1.push_back(pts1[idx1]);
        commonPts2.push_back(pts2[idx2]);
      }
    }

    if (static_cast<int>(commonObj.size()) < 6) {
      Napi::Object res = Napi::Object::New(env);
      res.Set("success", Napi::Boolean::New(env, false));
      std::string errorMsg =
          "Not enough common object points (commonObj.size()=" +
          std::to_string(commonObj.size()) + ", required: 6). " + debugMsg;
      res.Set("error", Napi::String::New(env, errorMsg));
      res.Set("commonCount",
              Napi::Number::New(env, static_cast<int>(commonObj.size())));
      return res;
    }

    g_stereoObjectPoints.push_back(commonObj);
    g_stereoImagePoints1.push_back(commonPts1);
    g_stereoImagePoints2.push_back(commonPts2);

    Napi::Object res = Napi::Object::New(env);
    res.Set("success", Napi::Boolean::New(env, true));
    res.Set("samples", Napi::Number::New(
                           env, static_cast<int>(g_stereoObjectPoints.size())));
    res.Set("points",
            Napi::Number::New(env, static_cast<int>(commonObj.size())));
    res.Set("commonCount",
            Napi::Number::New(env, static_cast<int>(commonObj.size())));
    return res;
  } catch (const cv::Exception &e) {
    return CreateErrorResult(env, e.what());
  }
}

// Compute stereo calibration (R, T)
// 内部パラメータがある場合: CALIB_FIX_INTRINSIC（固定）
// 内部パラメータがない場合: CALIB_USE_INTRINSIC_GUESS（同時推定）
// 参照:
// https://docs.opencv.org/4.x/d9/d0c/group__calib3d.html#ga91018d80e2a93ade37539f01e6f07de5
Napi::Value ComputeCharucoStereoCalibration(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  try {
    if (g_stereoObjectPoints.empty() || g_stereoImagePoints1.empty() ||
        g_stereoImagePoints2.empty()) {
      return CreateErrorResult(env, "No stereo samples captured");
    }

    cv::Mat R, T, E, F, perViewErrors;
    cv::TermCriteria criteria(cv::TermCriteria::COUNT + cv::TermCriteria::EPS,
                              100, 1e-6);

    int flags;
    bool hasIntrinsics = !g_K1.empty() && !g_K2.empty();

    if (hasIntrinsics) {
      // 内部パラメータが読み込まれている場合は固定
      flags = cv::CALIB_FIX_INTRINSIC;
    } else {
      // 内部パラメータがない場合は同時推定
      g_K1 = cv::Mat::eye(3, 3, CV_64F);
      g_K2 = cv::Mat::eye(3, 3, CV_64F);
      g_dist1 = cv::Mat::zeros(5, 1, CV_64F);
      g_dist2 = cv::Mat::zeros(5, 1, CV_64F);

      // 初期推定値を設定（画像サイズから推定）
      double fx = static_cast<double>(g_stereoImageSize.width);
      double fy = fx;
      double cx = g_stereoImageSize.width / 2.0;
      double cy = g_stereoImageSize.height / 2.0;

      g_K1.at<double>(0, 0) = fx;
      g_K1.at<double>(1, 1) = fy;
      g_K1.at<double>(0, 2) = cx;
      g_K1.at<double>(1, 2) = cy;

      g_K2.at<double>(0, 0) = fx;
      g_K2.at<double>(1, 1) = fy;
      g_K2.at<double>(0, 2) = cx;
      g_K2.at<double>(1, 2) = cy;

      // 同時推定フラグ（内部パラメータも最適化）
      flags = cv::CALIB_USE_INTRINSIC_GUESS;
    }

    double rms = cv::stereoCalibrate(g_stereoObjectPoints, g_stereoImagePoints1,
                                     g_stereoImagePoints2, g_K1, g_dist1, g_K2,
                                     g_dist2, g_stereoImageSize, R, T, E, F,
                                     perViewErrors, flags, criteria);

    // 各サンプルでのボード位置（Cam1座標系）を計算
    // 各サンプルでの画像ポイントとオブジェクトポイントから、solvePnPを使用してrvecs,
    // tvecsを計算
    std::vector<cv::Mat> stereoRvecs, stereoTvecs;
    for (size_t i = 0; i < g_stereoObjectPoints.size(); ++i) {
      cv::Mat rvec, tvec;
      cv::solvePnP(g_stereoObjectPoints[i], g_stereoImagePoints1[i], g_K1,
                   g_dist1, rvec, tvec, false, cv::SOLVEPNP_ITERATIVE);
      stereoRvecs.push_back(rvec.clone());
      stereoTvecs.push_back(tvec.clone());
    }

    Napi::Object result = Napi::Object::New(env);
    result.Set("success", Napi::Boolean::New(env, true));
    result.Set("rms", Napi::Number::New(env, rms));
    result.Set("hasIntrinsics", Napi::Boolean::New(env, hasIntrinsics));

    Napi::Array rArr = Napi::Array::New(env, 9);
    for (int i = 0; i < 9; ++i) {
      rArr[i] = Napi::Number::New(env, R.at<double>(i / 3, i % 3));
    }
    Napi::Array tArr = Napi::Array::New(env, 3);
    for (int i = 0; i < 3; ++i) {
      tArr[i] = Napi::Number::New(env, T.at<double>(i, 0));
    }
    result.Set("R", rArr);
    result.Set("T", tArr);
    result.Set("baseline", Napi::Number::New(env, cv::norm(T)));

    // 同時推定の場合、推定された内部パラメータを返す
    if (!hasIntrinsics) {
      // Cam1の内部パラメータ
      Napi::Array k1Arr = Napi::Array::New(env, 9);
      for (int i = 0; i < 9; ++i) {
        k1Arr[i] = Napi::Number::New(env, g_K1.at<double>(i / 3, i % 3));
      }
      Napi::Array d1Arr = Napi::Array::New(env, g_dist1.rows);
      for (int i = 0; i < g_dist1.rows; ++i) {
        d1Arr[i] = Napi::Number::New(env, g_dist1.at<double>(i, 0));
      }
      result.Set("K1", k1Arr);
      result.Set("dist1", d1Arr);

      // Cam2の内部パラメータ
      Napi::Array k2Arr = Napi::Array::New(env, 9);
      for (int i = 0; i < 9; ++i) {
        k2Arr[i] = Napi::Number::New(env, g_K2.at<double>(i / 3, i % 3));
      }
      Napi::Array d2Arr = Napi::Array::New(env, g_dist2.rows);
      for (int i = 0; i < g_dist2.rows; ++i) {
        d2Arr[i] = Napi::Number::New(env, g_dist2.at<double>(i, 0));
      }
      result.Set("K2", k2Arr);
      result.Set("dist2", d2Arr);
    }

    // 各サンプルでのボード位置（rvecs, tvecs）を返す
    Napi::Array rvecsArr = Napi::Array::New(env, stereoRvecs.size());
    Napi::Array tvecsArr = Napi::Array::New(env, stereoTvecs.size());
    for (size_t i = 0; i < stereoRvecs.size(); ++i) {
      Napi::Array rvec = Napi::Array::New(env, 3);
      Napi::Array tvec = Napi::Array::New(env, 3);
      for (int j = 0; j < 3; ++j) {
        rvec[j] = Napi::Number::New(env, stereoRvecs[i].at<double>(j, 0));
        tvec[j] = Napi::Number::New(env, stereoTvecs[i].at<double>(j, 0));
      }
      rvecsArr[i] = rvec;
      tvecsArr[i] = tvec;
    }
    result.Set("rvecs", rvecsArr);
    result.Set("tvecs", tvecsArr);

    // キャリブレーションに使用された点群データを返す
    // g_stereoObjectPoints
    Napi::Array stereoObjPtsArr =
        Napi::Array::New(env, g_stereoObjectPoints.size());
    for (size_t i = 0; i < g_stereoObjectPoints.size(); ++i) {
      Napi::Array pts = Napi::Array::New(env, g_stereoObjectPoints[i].size());
      for (size_t j = 0; j < g_stereoObjectPoints[i].size(); ++j) {
        Napi::Object pt = Napi::Object::New(env);
        pt.Set("x", Napi::Number::New(env, g_stereoObjectPoints[i][j].x));
        pt.Set("y", Napi::Number::New(env, g_stereoObjectPoints[i][j].y));
        pt.Set("z", Napi::Number::New(env, g_stereoObjectPoints[i][j].z));
        pts[j] = pt;
      }
      stereoObjPtsArr[i] = pts;
    }
    result.Set("objectPoints", stereoObjPtsArr);

    // g_stereoImagePoints1
    Napi::Array stereoImgPts1Arr =
        Napi::Array::New(env, g_stereoImagePoints1.size());
    for (size_t i = 0; i < g_stereoImagePoints1.size(); ++i) {
      Napi::Array pts = Napi::Array::New(env, g_stereoImagePoints1[i].size());
      for (size_t j = 0; j < g_stereoImagePoints1[i].size(); ++j) {
        Napi::Object pt = Napi::Object::New(env);
        pt.Set("x", Napi::Number::New(env, g_stereoImagePoints1[i][j].x));
        pt.Set("y", Napi::Number::New(env, g_stereoImagePoints1[i][j].y));
        pts[j] = pt;
      }
      stereoImgPts1Arr[i] = pts;
    }
    result.Set("imagePoints1", stereoImgPts1Arr);

    // g_stereoImagePoints2
    Napi::Array stereoImgPts2Arr =
        Napi::Array::New(env, g_stereoImagePoints2.size());
    for (size_t i = 0; i < g_stereoImagePoints2.size(); ++i) {
      Napi::Array pts = Napi::Array::New(env, g_stereoImagePoints2[i].size());
      for (size_t j = 0; j < g_stereoImagePoints2[i].size(); ++j) {
        Napi::Object pt = Napi::Object::New(env);
        pt.Set("x", Napi::Number::New(env, g_stereoImagePoints2[i][j].x));
        pt.Set("y", Napi::Number::New(env, g_stereoImagePoints2[i][j].y));
        pts[j] = pt;
      }
      stereoImgPts2Arr[i] = pts;
    }
    result.Set("imagePoints2", stereoImgPts2Arr);

    // ビューごとのRMS誤差を返す（棒グラフ表示用）
    // perViewErrors は Nx2 の Mat (各ビューのCam1/Cam2 RMS誤差)
    Napi::Array perViewErrorsArr =
        Napi::Array::New(env, static_cast<uint32_t>(perViewErrors.rows));
    for (int i = 0; i < perViewErrors.rows; ++i) {
      // Cam1とCam2の誤差の平均をビューRMSとする
      double e1 = perViewErrors.at<double>(i, 0);
      double e2 = perViewErrors.at<double>(i, 1);
      double viewRms = (e1 + e2) / 2.0;
      perViewErrorsArr[static_cast<uint32_t>(i)] =
          Napi::Number::New(env, viewRms);
    }
    result.Set("perViewErrors", perViewErrorsArr);

    return result;
  } catch (const cv::Exception &e) {
    return CreateErrorResult(env, e.what());
  }
}

// Compute stereo calibration with exclusions (ビュー除外付き再計算)
Napi::Value
ComputeCharucoStereoCalibrationWithExclusions(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();

  std::set<int> exclude;
  if (info.Length() > 0 && info[0].IsArray()) {
    Napi::Array exArr = info[0].As<Napi::Array>();
    for (uint32_t i = 0; i < exArr.Length(); ++i) {
      if (!exArr.Get(i).IsNumber())
        continue;
      int idx = exArr.Get(i).As<Napi::Number>().Int32Value();
      if (idx >= 0)
        exclude.insert(idx);
    }
  }

  try {
    if (g_stereoObjectPoints.empty() || g_stereoImagePoints1.empty() ||
        g_stereoImagePoints2.empty()) {
      return CreateErrorResult(env, "No stereo samples captured");
    }

    // 除外フィルタリング
    std::vector<std::vector<cv::Point3f>> objPts;
    std::vector<std::vector<cv::Point2f>> imgPts1, imgPts2;
    for (size_t i = 0; i < g_stereoObjectPoints.size(); ++i) {
      if (exclude.count(static_cast<int>(i)) > 0)
        continue;
      objPts.push_back(g_stereoObjectPoints[i]);
      imgPts1.push_back(g_stereoImagePoints1[i]);
      imgPts2.push_back(g_stereoImagePoints2[i]);
    }

    if (objPts.empty()) {
      return CreateErrorResult(env, "All stereo samples are excluded");
    }

    cv::Mat R, T, E, F, perViewErrors;
    cv::TermCriteria criteria(cv::TermCriteria::COUNT + cv::TermCriteria::EPS,
                              100, 1e-6);

    int flags;
    bool hasIntrinsics = !g_K1.empty() && !g_K2.empty() &&
                         g_K1.at<double>(0, 0) > 1.0;
    if (hasIntrinsics) {
      flags = cv::CALIB_FIX_INTRINSIC;
    } else {
      g_K1 = cv::Mat::eye(3, 3, CV_64F);
      g_K2 = cv::Mat::eye(3, 3, CV_64F);
      g_dist1 = cv::Mat::zeros(5, 1, CV_64F);
      g_dist2 = cv::Mat::zeros(5, 1, CV_64F);
      double fx = static_cast<double>(g_stereoImageSize.width);
      g_K1.at<double>(0, 0) = fx;
      g_K1.at<double>(1, 1) = fx;
      g_K1.at<double>(0, 2) = g_stereoImageSize.width / 2.0;
      g_K1.at<double>(1, 2) = g_stereoImageSize.height / 2.0;
      g_K2.at<double>(0, 0) = fx;
      g_K2.at<double>(1, 1) = fx;
      g_K2.at<double>(0, 2) = g_stereoImageSize.width / 2.0;
      g_K2.at<double>(1, 2) = g_stereoImageSize.height / 2.0;
      flags = cv::CALIB_USE_INTRINSIC_GUESS;
    }

    double rms = cv::stereoCalibrate(objPts, imgPts1, imgPts2, g_K1, g_dist1,
                                     g_K2, g_dist2, g_stereoImageSize, R, T, E,
                                     F, perViewErrors, flags, criteria);

    Napi::Object result = Napi::Object::New(env);
    result.Set("success", Napi::Boolean::New(env, true));
    result.Set("rms", Napi::Number::New(env, rms));
    result.Set("baseline", Napi::Number::New(env, cv::norm(T)));
    result.Set("samples",
               Napi::Number::New(env, static_cast<int>(objPts.size())));

    Napi::Array rArr = Napi::Array::New(env, 9);
    for (int i = 0; i < 9; ++i)
      rArr[i] = Napi::Number::New(env, R.at<double>(i / 3, i % 3));
    Napi::Array tArr = Napi::Array::New(env, 3);
    for (int i = 0; i < 3; ++i)
      tArr[i] = Napi::Number::New(env, T.at<double>(i, 0));
    result.Set("R", rArr);
    result.Set("T", tArr);

    // ビューごとのRMS誤差
    Napi::Array pvArr =
        Napi::Array::New(env, static_cast<uint32_t>(perViewErrors.rows));
    for (int i = 0; i < perViewErrors.rows; ++i) {
      double e1 = perViewErrors.at<double>(i, 0);
      double e2 = perViewErrors.at<double>(i, 1);
      pvArr[static_cast<uint32_t>(i)] =
          Napi::Number::New(env, (e1 + e2) / 2.0);
    }
    result.Set("perViewErrors", pvArr);

    return result;
  } catch (const cv::Exception &e) {
    return CreateErrorResult(env, e.what());
  }
}

// ============================
// Stereo triangulation (3D reconstruction)
// ============================
// 参照: OpenCV calib3d (undistortPoints, triangulatePoints)
// https://docs.opencv.org/4.x/d9/d0c/group__calib3d.html
Napi::Value TriangulateStereoPoints(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 8) {
    Napi::TypeError::New(env, "Expected pts1, pts2, K1, dist1, K2, dist2, R, T")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  try {
    Napi::Array pts1Arr = info[0].As<Napi::Array>();
    Napi::Array pts2Arr = info[1].As<Napi::Array>();
    Napi::Array k1Arr = info[2].As<Napi::Array>();
    Napi::Array d1Arr = info[3].As<Napi::Array>();
    Napi::Array k2Arr = info[4].As<Napi::Array>();
    Napi::Array d2Arr = info[5].As<Napi::Array>();
    Napi::Array rArr = info[6].As<Napi::Array>();
    Napi::Array tArr = info[7].As<Napi::Array>();

    const uint32_t n1 = pts1Arr.Length();
    const uint32_t n2 = pts2Arr.Length();
    if (n1 == 0 || n2 == 0 || n1 != n2) {
      return CreateErrorResult(env, "pts1/pts2 must have same non-zero length");
    }

    // 2D点配列を cv::Point2f ベクタに変換
    std::vector<cv::Point2f> pts1;
    std::vector<cv::Point2f> pts2;
    pts1.reserve(n1);
    pts2.reserve(n2);

    auto readPoint = [&](Napi::Value v, cv::Point2f &out) -> bool {
      if (!v.IsObject())
        return false;
      Napi::Object o = v.As<Napi::Object>();
      if (!o.Has("x") || !o.Has("y"))
        return false;
      out.x = static_cast<float>(o.Get("x").As<Napi::Number>().DoubleValue());
      out.y = static_cast<float>(o.Get("y").As<Napi::Number>().DoubleValue());
      return true;
    };

    for (uint32_t i = 0; i < n1; ++i) {
      cv::Point2f p1, p2;
      if (!readPoint(pts1Arr.Get(i), p1) || !readPoint(pts2Arr.Get(i), p2)) {
        return CreateErrorResult(env, "Invalid point format in pts1/pts2");
      }
      pts1.push_back(p1);
      pts2.push_back(p2);
    }

    cv::Mat pts1Mat(static_cast<int>(pts1.size()), 1, CV_32FC2, pts1.data());
    cv::Mat pts2Mat(static_cast<int>(pts2.size()), 1, CV_32FC2, pts2.data());

    // 内部パラメータ・歪み・外部パラメータを cv::Mat に復元
    cv::Mat K1 = cv::Mat::eye(3, 3, CV_64F);
    cv::Mat K2 = cv::Mat::eye(3, 3, CV_64F);
    cv::Mat dist1(static_cast<int>(d1Arr.Length()), 1, CV_64F);
    cv::Mat dist2(static_cast<int>(d2Arr.Length()), 1, CV_64F);
    cv::Mat R(3, 3, CV_64F);
    cv::Mat T(3, 1, CV_64F);

    for (uint32_t i = 0; i < 9 && i < k1Arr.Length(); ++i) {
      K1.at<double>(static_cast<int>(i / 3), static_cast<int>(i % 3)) =
          k1Arr.Get(i).As<Napi::Number>().DoubleValue();
    }
    for (uint32_t i = 0; i < 9 && i < k2Arr.Length(); ++i) {
      K2.at<double>(static_cast<int>(i / 3), static_cast<int>(i % 3)) =
          k2Arr.Get(i).As<Napi::Number>().DoubleValue();
    }
    for (uint32_t i = 0; i < d1Arr.Length(); ++i) {
      dist1.at<double>(static_cast<int>(i), 0) =
          d1Arr.Get(i).As<Napi::Number>().DoubleValue();
    }
    for (uint32_t i = 0; i < d2Arr.Length(); ++i) {
      dist2.at<double>(static_cast<int>(i), 0) =
          d2Arr.Get(i).As<Napi::Number>().DoubleValue();
    }
    for (uint32_t i = 0; i < 9 && i < rArr.Length(); ++i) {
      R.at<double>(static_cast<int>(i / 3), static_cast<int>(i % 3)) =
          rArr.Get(i).As<Napi::Number>().DoubleValue();
    }
    for (uint32_t i = 0; i < 3 && i < tArr.Length(); ++i) {
      T.at<double>(static_cast<int>(i), 0) =
          tArr.Get(i).As<Napi::Number>().DoubleValue();
    }

    // 正規化座標への変換 (歪み補正込み)
    cv::Mat pts1Norm, pts2Norm;
    cv::undistortPoints(pts1Mat, pts1Norm, K1, dist1);
    cv::undistortPoints(pts2Mat, pts2Norm, K2, dist2);

    // Nx1x2 -> 2xN に整形
    pts1Norm = pts1Norm.reshape(2, static_cast<int>(pts1.size())).t();
    pts2Norm = pts2Norm.reshape(2, static_cast<int>(pts2.size())).t();

    // 投影行列 P1=[I|0], P2=[R|T]（正規化画像平面）
    cv::Mat P1 = cv::Mat::zeros(3, 4, CV_64F);
    cv::Mat P2 = cv::Mat::zeros(3, 4, CV_64F);
    cv::Mat I = cv::Mat::eye(3, 3, CV_64F);
    I.copyTo(P1(cv::Rect(0, 0, 3, 3)));
    R.copyTo(P2(cv::Rect(0, 0, 3, 3)));
    T.copyTo(P2(cv::Rect(3, 0, 1, 3)));

    // 三角測量
    cv::Mat points4D;
    cv::triangulatePoints(P1, P2, pts1Norm, pts2Norm, points4D);

    const int N = points4D.cols;
    Napi::Array outPoints = Napi::Array::New(env, N);
    for (int i = 0; i < N; ++i) {
      cv::Vec4d p = points4D.col(i);
      double w = p[3];
      if (std::abs(w) < 1e-12)
        w = 1e-12;
      double X = p[0] / w;
      double Y = p[1] / w;
      double Z = p[2] / w;
      Napi::Object jp = Napi::Object::New(env);
      jp.Set("x", Napi::Number::New(env, X));
      jp.Set("y", Napi::Number::New(env, Y));
      jp.Set("z", Napi::Number::New(env, Z));
      outPoints[i] = jp;
    }

    Napi::Object res = Napi::Object::New(env);
    res.Set("success", Napi::Boolean::New(env, true));
    res.Set("points3D", outPoints);
    return res;
  } catch (const cv::Exception &e) {
    return CreateErrorResult(env, e.what());
  }
}

// ChArUcoシングルモード: 画像座標から実長座標への変換（ボード平面上）
// 入力: 画像座標配列、カメラマトリックス、歪み係数、rvec、tvec
// 出力: ボード平面上の2次元実長座標（X, Y）
Napi::Value ProjectPointsInverse(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 5) {
    Napi::TypeError::New(env, "Wrong number of arguments")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  try {
    // 引数の取得
    Napi::Array imagePointsArr = info[0].As<Napi::Array>();
    Napi::Array KArr = info[1].As<Napi::Array>();
    Napi::Array distArr = info[2].As<Napi::Array>();
    Napi::Array rvecArr = info[3].As<Napi::Array>();
    Napi::Array tvecArr = info[4].As<Napi::Array>();

    // カメラマトリックスと歪み係数を構築
    cv::Mat K = cv::Mat::eye(3, 3, CV_64F);
    cv::Mat distCoeffs(static_cast<int>(distArr.Length()), 1, CV_64F);

    for (uint32_t i = 0; i < 9 && i < KArr.Length(); ++i) {
      K.at<double>(static_cast<int>(i / 3), static_cast<int>(i % 3)) =
          KArr.Get(i).As<Napi::Number>().DoubleValue();
    }
    for (uint32_t i = 0; i < distArr.Length(); ++i) {
      distCoeffs.at<double>(static_cast<int>(i), 0) =
          distArr.Get(i).As<Napi::Number>().DoubleValue();
    }

    // rvecとtvecを構築
    cv::Mat rvec(3, 1, CV_64F);
    cv::Mat tvec(3, 1, CV_64F);
    for (uint32_t i = 0; i < 3 && i < rvecArr.Length(); ++i) {
      rvec.at<double>(static_cast<int>(i), 0) =
          rvecArr.Get(i).As<Napi::Number>().DoubleValue();
    }
    for (uint32_t i = 0; i < 3 && i < tvecArr.Length(); ++i) {
      tvec.at<double>(static_cast<int>(i), 0) =
          tvecArr.Get(i).As<Napi::Number>().DoubleValue();
    }

    // 回転行列に変換
    cv::Mat R;
    cv::Rodrigues(rvec, R);

    // 画像座標をundistortして正規化座標に変換
    std::vector<cv::Point2f> imagePoints;
    const uint32_t nPoints = imagePointsArr.Length();
    imagePoints.reserve(nPoints);

    for (uint32_t i = 0; i < nPoints; ++i) {
      Napi::Value v = imagePointsArr.Get(i);
      if (!v.IsObject())
        continue;
      Napi::Object p = v.As<Napi::Object>();
      if (!p.Has("x") || !p.Has("y"))
        continue;
      float x = static_cast<float>(p.Get("x").As<Napi::Number>().DoubleValue());
      float y = static_cast<float>(p.Get("y").As<Napi::Number>().DoubleValue());
      imagePoints.push_back(cv::Point2f(x, y));
    }

    if (imagePoints.empty()) {
      return CreateErrorResult(env, "No valid image points");
    }

    // undistortPointsで正規化座標に変換
    std::vector<cv::Point2f> normalizedPoints;
    cv::undistortPoints(imagePoints, normalizedPoints, K, distCoeffs,
                        cv::noArray(), K);

    // ボード平面上（Z=0）の3D点を計算
    // カメラ光線とボード平面の交点を計算
    std::vector<cv::Point2f> realPoints2D;
    realPoints2D.reserve(normalizedPoints.size());

    // ボードの法線ベクトル（カメラ座標系）= Rの3列目（ボードのZ軸）
    cv::Mat n_cam = R.col(2).clone(); // クローンして独立したベクトルにする

    // ボード平面の方程式: n^T * (P_cam - tvec) = 0
    // カメラ光線: P_cam = lambda * [u_norm, v_norm, 1]
    // 交点: n^T * (lambda * [u_norm, v_norm, 1] - tvec) = 0
    // lambda * n^T * [u_norm, v_norm, 1] = n^T * tvec
    // lambda = (n^T * tvec) / (n^T * [u_norm, v_norm, 1])

    // n_camを転置して1x3の行ベクトルにする
    cv::Mat nT = n_cam.t();

    for (size_t i = 0; i < normalizedPoints.size(); ++i) {
      const cv::Point2f &normPt = normalizedPoints[i];

      // カメラ光線の方向ベクトル（正規化座標）
      cv::Mat ray_dir(3, 1, CV_64F);
      ray_dir.at<double>(0, 0) = normPt.x;
      ray_dir.at<double>(1, 0) = normPt.y;
      ray_dir.at<double>(2, 0) = 1.0;

      // ボード平面との交点を計算
      // nTは1x3、ray_dirは3x1なので、nT * ray_dirで内積が計算される
      cv::Mat nT_ray_mat = nT * ray_dir;
      double nT_ray = nT_ray_mat.at<double>(0, 0);

      if (std::abs(nT_ray) < 1e-10) {
        // 光線がボード平面と平行
        realPoints2D.push_back(cv::Point2f(0, 0));
        continue;
      }

      // nTは1x3、tvecは3x1なので、nT * tvecで内積が計算される
      cv::Mat nT_tvec_mat = nT * tvec;
      double nT_tvec = nT_tvec_mat.at<double>(0, 0);
      double lambda = nT_tvec / nT_ray;

      // カメラ座標系での3D点
      cv::Mat P_cam = lambda * ray_dir;

      // ボード座標系に変換: P_board = R^T * (P_cam - tvec)
      cv::Mat P_cam_relative = P_cam - tvec;
      cv::Mat P_board = R.t() * P_cam_relative;

      // ボード平面上の2次元座標（X, Y）
      realPoints2D.push_back(
          cv::Point2f(static_cast<float>(P_board.at<double>(0, 0)),
                      static_cast<float>(P_board.at<double>(1, 0))));
    }

    // 結果をNapi::Arrayに変換
    Napi::Array resultArray = Napi::Array::New(env, realPoints2D.size());
    for (size_t i = 0; i < realPoints2D.size(); ++i) {
      Napi::Object pt = Napi::Object::New(env);
      pt.Set("x", Napi::Number::New(env, realPoints2D[i].x));
      pt.Set("y", Napi::Number::New(env, realPoints2D[i].y));
      resultArray[i] = pt;
    }

    Napi::Object res = Napi::Object::New(env);
    res.Set("success", Napi::Boolean::New(env, true));
    res.Set("points2D", resultArray);
    return res;
  } catch (const cv::Exception &e) {
    return CreateErrorResult(env, e.what());
  } catch (const std::exception &e) {
    return CreateErrorResult(env, e.what());
  }
}

// 歪み補正画像の生成
Napi::Value UndistortImage(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 3) {
    Napi::TypeError::New(env, "Wrong number of arguments")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  try {
    // 引数の取得
    std::string videoPath = info[0].As<Napi::String>();
    int frameNumber = info[1].As<Napi::Number>().Int32Value();
    Napi::Array KArr = info[2].As<Napi::Array>();
    Napi::Array distArr = info[3].As<Napi::Array>();

    // カメラマトリックスと歪み係数を構築
    cv::Mat K = cv::Mat::eye(3, 3, CV_64F);
    cv::Mat distCoeffs(static_cast<int>(distArr.Length()), 1, CV_64F);

    for (uint32_t i = 0; i < 9 && i < KArr.Length(); ++i) {
      K.at<double>(static_cast<int>(i / 3), static_cast<int>(i % 3)) =
          KArr.Get(i).As<Napi::Number>().DoubleValue();
    }
    for (uint32_t i = 0; i < distArr.Length(); ++i) {
      distCoeffs.at<double>(static_cast<int>(i), 0) =
          distArr.Get(i).As<Napi::Number>().DoubleValue();
    }

    // フレームを取得
    cv::Mat frame;
    if (g_currentVideoPath != videoPath) {
      g_videoCapture.release();
      g_videoCapture.open(videoPath);
      g_currentVideoPath = videoPath;
      g_lastFrameNumber = -1;
      g_frameCache.clear();
    }

    if (!g_videoCapture.isOpened()) {
      return CreateErrorResult(env, "Failed to open video");
    }

    if (g_lastFrameNumber != frameNumber) {
      g_videoCapture.set(cv::CAP_PROP_POS_FRAMES, frameNumber - 1);
      g_lastFrameNumber = frameNumber;
    }

    const std::string cacheKey = g_currentVideoPath + ":" + std::to_string(frameNumber);
    if (g_frameCache.find(cacheKey) != g_frameCache.end()) {
      frame = g_frameCache[cacheKey];
    } else {
      if (!g_videoCapture.read(frame)) {
        return CreateErrorResult(env, "Failed to read frame");
      }
      g_frameCache[cacheKey] = frame.clone();
      if (g_frameCache.size() > CACHE_SIZE) {
        g_frameCache.erase(g_frameCache.begin());
      }
    }

    if (frame.empty()) {
      return CreateErrorResult(env, "Frame is empty");
    }

    // デバッグ: 歪み係数をログ出力
    std::cout << "[UNDISTORT DEBUG C++] ===== 歪み補正処理開始 ====="
              << std::endl;
    std::cout << "[UNDISTORT DEBUG C++] distCoeffs size: " << distCoeffs.rows
              << "x" << distCoeffs.cols << std::endl;
    for (int i = 0; i < distCoeffs.rows; i++) {
      std::cout << "[UNDISTORT DEBUG C++] distCoeffs[" << i
                << "]: " << distCoeffs.at<double>(i, 0) << std::endl;
    }
    std::cout << "[UNDISTORT DEBUG C++] K matrix:" << std::endl;
    std::cout << "  fx: " << K.at<double>(0, 0)
              << ", fy: " << K.at<double>(1, 1) << std::endl;
    std::cout << "  cx: " << K.at<double>(0, 2)
              << ", cy: " << K.at<double>(1, 2) << std::endl;
    std::cout << "[UNDISTORT DEBUG C++] Original frame size: " << frame.cols
              << "x" << frame.rows << std::endl;

    // 歪み補正を実行
    cv::Mat undistortedFrame;
    cv::undistort(frame, undistortedFrame, K, distCoeffs);

    std::cout << "[UNDISTORT DEBUG C++] Undistorted frame size: "
              << undistortedFrame.cols << "x" << undistortedFrame.rows
              << std::endl;
    std::cout << "[UNDISTORT DEBUG C++] ================================"
              << std::endl;

    // 回転補正（rvecが提供された場合）
    cv::Mat finalFrame = undistortedFrame;
    if (info.Length() >= 5 && !info[4].IsUndefined() && !info[4].IsNull()) {
      Napi::Array rvecArr = info[4].As<Napi::Array>();
      if (rvecArr.Length() >= 3) {
        cv::Vec3d rvec;
        rvec[0] = rvecArr.Get(0u).As<Napi::Number>().DoubleValue();
        rvec[1] = rvecArr.Get(1u).As<Napi::Number>().DoubleValue();
        rvec[2] = rvecArr.Get(2u).As<Napi::Number>().DoubleValue();

        // 回転ベクトルから回転行列を計算
        cv::Mat R;
        cv::Rodrigues(rvec, R);

        // 回転行列からオイラー角を計算（ZYX順序）
        // ただし、水平・垂直補正のため、Z軸回転（カメラの水平方向の傾き）のみを考慮
        double sy = std::sqrt(R.at<double>(0, 0) * R.at<double>(0, 0) +
                              R.at<double>(1, 0) * R.at<double>(1, 0));
        bool singular = sy < 1e-6;

        double yaw = 0.0; // Z軸回転（水平方向の傾き）
        if (!singular) {
          yaw = std::atan2(R.at<double>(1, 0), R.at<double>(0, 0));
        }

        // 画像中心を基準に回転
        cv::Point2f center(static_cast<float>(undistortedFrame.cols) / 2.0f,
                           static_cast<float>(undistortedFrame.rows) / 2.0f);
        cv::Mat rotationMatrix =
            cv::getRotationMatrix2D(center, -yaw * 180.0 / CV_PI, 1.0);

        // 回転後の画像サイズを計算
        cv::Rect2f bbox =
            cv::RotatedRect(cv::Point2f(), undistortedFrame.size(),
                            -yaw * 180.0 / CV_PI)
                .boundingRect2f();
        rotationMatrix.at<double>(0, 2) +=
            bbox.width / 2.0 - undistortedFrame.cols / 2.0;
        rotationMatrix.at<double>(1, 2) +=
            bbox.height / 2.0 - undistortedFrame.rows / 2.0;

        cv::warpAffine(undistortedFrame, finalFrame, rotationMatrix,
                       bbox.size());
      }
    }

    // Base64エンコード
    std::vector<uchar> buffer;
    cv::imencode(".png", finalFrame, buffer);
    std::string base64String = base64_encode(buffer.data(), buffer.size());

    Napi::Object result = Napi::Object::New(env);
    result.Set("success", Napi::Boolean::New(env, true));
    result.Set("frameData", Napi::String::New(env, base64String));
    result.Set("width", Napi::Number::New(env, finalFrame.cols));
    result.Set("height", Napi::Number::New(env, finalFrame.rows));
    return result;
  } catch (const cv::Exception &e) {
    return CreateErrorResult(env, e.what());
  } catch (const std::exception &e) {
    return CreateErrorResult(env, e.what());
  }
}

// Initialize module
Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("extractFrame", Napi::Function::New(env, ExtractFrame));
  exports.Set("getVideoInfo", Napi::Function::New(env, GetVideoInfo));
  exports.Set("loadImage", Napi::Function::New(env, LoadImage));
  exports.Set("processImage", Napi::Function::New(env, ProcessImage));
  exports.Set("getImageCoordinatesWithMouseCallback",
              Napi::Function::New(env, GetImageCoordinatesWithMouseCallback));
  exports.Set("zoomImage", Napi::Function::New(env, ZoomImage));
  exports.Set("getZoomedImageCoordinates",
              Napi::Function::New(env, GetZoomedImageCoordinates));
  exports.Set("getDisplayCoordinates",
              Napi::Function::New(env, GetDisplayCoordinates));
  exports.Set("getImageCoordinates",
              Napi::Function::New(env, GetImageCoordinates));
  exports.Set("getMouseClickCoordinates",
              Napi::Function::New(env, GetMouseClickCoordinates));
  exports.Set("detectCharucoBoard",
              Napi::Function::New(env, DetectCharucoBoard));
  exports.Set("startCharucoCalibrationSession",
              Napi::Function::New(env, StartCharucoCalibrationSession));
  exports.Set("captureCharucoSample",
              Napi::Function::New(env, CaptureCharucoSample));
  exports.Set("computeCharucoCalibration",
              Napi::Function::New(env, ComputeCharucoCalibration));
  exports.Set(
      "computeCharucoCalibrationWithExclusions",
      Napi::Function::New(env, ComputeCharucoCalibrationWithExclusions));
  exports.Set("restoreCalibrationBuffers",
              Napi::Function::New(env, RestoreCalibrationBuffers));
  // Stereo Charuco calibration (fixed intrinsics)
  exports.Set("startCharucoStereoCalibrationSession",
              Napi::Function::New(env, StartCharucoStereoCalibrationSession));
  exports.Set("captureCharucoStereoSample",
              Napi::Function::New(env, CaptureCharucoStereoSample));
  exports.Set("computeCharucoStereoCalibrationWithExclusions",
              Napi::Function::New(
                  env, ComputeCharucoStereoCalibrationWithExclusions));
  exports.Set("computeCharucoStereoCalibration",
              Napi::Function::New(env, ComputeCharucoStereoCalibration));
  // Stereo triangulation (3D reconstruction)
  exports.Set("triangulateStereoPoints",
              Napi::Function::New(env, TriangulateStereoPoints));
  // ChArUco single: Project points inverse (image to real coordinates on board
  // plane)
  exports.Set("projectPointsInverse",
              Napi::Function::New(env, ProjectPointsInverse));
  // Undistort image
  exports.Set("undistortImage", Napi::Function::New(env, UndistortImage));
  return exports;
}

NODE_API_MODULE(opencv_module, Init)