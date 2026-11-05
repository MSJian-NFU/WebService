<?php
// run_ml.php
// 可同時執行三種分析模式：
// 1️⃣ analysis.py          -> 數值分析
// 2️⃣ main_analysis.py     -> 英文關鍵字分析
// 3️⃣ main_analysis_cn.py  -> 中文關鍵字分析

$mode = $_POST['mode'] ?? '';

if (!isset($_FILES['files'])) {
    echo "<p style='color:red;'>❌ 檔案上傳失敗</p>";
    exit;
}
if (!isset($_FILES['abandon'])) {
    echo "<p style='color:red;'>❌ Adnadon檔案上傳失敗</p>";
    exit;
}

// === 上傳 / 輸出 資料夾設定 ===
$upload_dir = __DIR__ . '/uploads/';
$output_dir_en = __DIR__ . '/output/';
$output_dir_cn = __DIR__ . '/output_cn/';
$output_dir_st = __DIR__ . '/output_st/';
if (!is_dir($upload_dir)) mkdir($upload_dir);
if (!is_dir($output_dir_en)) mkdir($output_dir_en);
if (!is_dir($output_dir_cn)) mkdir($output_dir_cn);
if (!is_dir($output_dir_st)) mkdir($output_dir_st);
// === 安全清空舊檔案 ===
function safe_clear_dir($dir) {
    foreach (glob($dir . '*') as $file) {
        if (is_file($file) && is_writable($file)) {
            @unlink($file);
        }
    }
}

// 加一點延遲避免檔案被佔用
usleep(300000);
safe_clear_dir($upload_dir);
safe_clear_dir($output_dir_en);
safe_clear_dir($output_dir_cn);

// === 上傳使用者檔案 ===
foreach ($_FILES['files']['tmp_name'] as $i => $tmp_name) {
    $name = basename($_FILES['files']['name'][$i]);
    move_uploaded_file($tmp_name, $upload_dir . $name);
}
{
    $AbandonFile = $_FILES['abandon']['tmp_name'];
    $name2 = $upload_dir . 'stop_words.txt';
    move_uploaded_file($AbandonFile, $name2);
}
{
    $SearchTarget = $_FILES['searchkey']['tmp_name'];
    $name3 = $upload_dir . 'target-search.txt';
    move_uploaded_file($SearchTarget, $name3);
}

// === 根據模式選擇 Python 腳本 ===
switch ($mode) {
    case 'main_analysis_cn':
        $script = 'main_analysis_cn.py';
        $output_folder = $output_dir_cn;
        $title = "中文關鍵字分析結果";
        break;
    case 'main_analysis':
        $script = 'main_analysis.py';
        $output_folder = $output_dir_en;
        $title = "英文關鍵字分析結果";
        break;
    case 'SearchTarget':
        $script = 'SearchTarget.py';
        $output_folder = $output_dir_st;
        $title = "精準文字段落搜尋分析結果";
        break;    
    default:
        $script = 'analysis.py';
        $output_folder = $output_dir_en;
        $title = "數值資料分析結果";
        break;
}

// === 找出上傳的第一個檔案 ===
$uploaded_files = glob($upload_dir . '*');
if (count($uploaded_files) === 0) {
    echo "<p style='color:red;'>❌ 沒有上傳任何檔案</p>";
    exit;
}
$input_path = $uploaded_files[0];

// === Python 執行指令 ===
// ⚠️ 若系統不認 "python"，請改成你的實際路徑，例如：
// $python = "C:\\Users\\88695\\AppData\\Local\\Programs\\Python\\Python39\\python.exe";
$python = "python";

// 使用 addslashes() 處理含空白、括號、中文的路徑
$cmd = "\"$python\" \"$script\" \"" . addslashes($input_path) . "\" \"" . addslashes($output_folder) . "\" 2>&1";

// === 顯示執行指令（方便除錯） ===
echo "<pre style='background:#eee;padding:6px;border-radius:6px;'>執行指令：$cmd</pre>";

exec($cmd, $output, $ret);
set_time_limit(0);
echo "<h2>{$title}</h2>";

// === 若 Python 發生錯誤 ===
if ($ret !== 0) {
    echo "<p style='color:red;'>❌ 分析時發生錯誤：</p>";
    echo "<pre style='background:#fee;padding:10px;border-radius:8px;'>"
        . htmlspecialchars(implode("\n", $output)) . "</pre>";
    exit;
}

// === 顯示 Python 終端輸出 ===
echo "<pre style='background:#eef;padding:8px;border-radius:6px;'>"
    . htmlspecialchars(implode("\n", $output)) . "</pre>";

// === 顯示圖片結果（改成固定網址顯示） ===
$images = glob($output_folder . "*.png");
if ($images) {
    echo "<h3>📈 圖像結果：</h3>";
    foreach ($images as $img) {
        $filename = basename($img);

        // ✅ 依輸出資料夾選擇對應網址
        if (strpos($output_folder, 'output_cn') !== false) {
            $img_url = "/ml_webapp/output_cn/" . $filename;
        } else {
            $img_url = "/ml_webapp/output/" . $filename;
        }

        echo "<div style='margin:10px 0;'>";
        echo "<img src='$img_url' width='650' style='border:1px solid #ccc;border-radius:8px;box-shadow:2px 2px 8px #ddd;'><br>";
        echo "<small>$filename</small>";
        echo "</div>";
    }
} else {
    echo "<p>⚠️ 沒有產生圖片輸出。</p>";
}


// === 顯示文字結果（如果有） ===
$summary_file = $output_folder . "pca_keywords_summary.txt";
if (file_exists($summary_file)) {
    echo "<h3>🧾 關鍵詞分析摘要：</h3>";
    echo "<pre style='background:#f9f9f9;padding:10px;border-radius:10px;white-space:pre-wrap;'>"
        . htmlspecialchars(file_get_contents($summary_file)) . "</pre>";
}
$summary_file = $output_folder . "search_results.csv";
if (file_exists($summary_file)) {
    echo "<h3>🧾 關鍵詞分析摘要：</h3>";
    echo '<a href="./output_st/search_results.csv">下載分析結果檔案 Download File</a><br>';
    echo "<pre style='background:#f9f9f9;padding:10px;border-radius:10px;white-space:pre-wrap;'>"
        . htmlspecialchars(file_get_contents($summary_file)) . "</pre>";
}

echo "<p style='color:green;'>✅ 分析完成</p>";
?>
