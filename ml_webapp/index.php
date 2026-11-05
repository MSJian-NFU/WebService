<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<title>AI 文件與資料分析系統</title>
<style>
body {
  font-family: "Microsoft JhengHei", sans-serif;
  background-color: #f7f9fb;
  margin: 0;
  padding: 30px;
}
h1 {
  text-align: center;
  color: #333;
}
form {
  background: #fff;
  border-radius: 12px;
  padding: 25px;
  max-width: 650px;
  margin: 0 auto;
  box-shadow: 0 4px 12px rgba(0,0,0,0.1);
}
select, input[type=file], button {
  width: 100%;
  font-size: 16px;
  margin-top: 10px;
  margin-bottom: 15px;
  padding: 8px;
}
button {
  background: #0066cc;
  color: white;
  border: none;
  border-radius: 8px;
  cursor: pointer;
}
button:hover { background: #0050a3; }
.result {
  max-width: 850px;
  margin: 30px auto;
  background: #fff;
  padding: 25px;
  border-radius: 10px;
  box-shadow: 0 0 10px rgba(0,0,0,0.08);
}
iframe {
  width: 100%;
  height: 800px;
  border: none;
}
#loading {
  display: none;
  text-align: center;
  font-size: 20px;
  color: #444;
  padding: 20px;
}
</style>
<script>
function showLoading() {
  document.getElementById('loading').style.display = 'block';
  document.getElementById('resultFrame').style.display = 'none';
}
function hideLoading() {
  document.getElementById('loading').style.display = 'none';
  document.getElementById('resultFrame').style.display = 'block';
}
</script>
</head>
<body>

<h1>📊 AI 文件與資料分析系統</h1>

<form action="run_ml.php" method="post" enctype="multipart/form-data" target="resultFrame" onsubmit="showLoading()">
  <label><b>分析模式：</b></label>
  <select name="mode" required>
    <option value="analysis">數值分析 Numerical Analysis</option>
    <option value="main_analysis">英文關鍵字分析 English Article Analysis</option>
    <option value="main_analysis_cn">中文關鍵字分析 Madarin Article Analysis</option>
    <option value="SearchTarget">精準文字段落搜尋 Precision Article Section Search</option>
  </select>

  <label><b>請選擇要上傳的檔案（可多選）Please select the files you wish to upload (multiple selections are allowed)：</b></label>
  <input type="file" name="files[]" multiple required>

  <label><b>請選擇要上傳的停用詞彙資料檔案 Please select the stop word data file you wish to upload：</b></label>
  <input type="file" name="abandon">

  <label><b>請選擇要做為搜尋詞彙的資料檔案 Please select the file you want to use as the search term：</b></label>
  <input type="file" name="searchkey">

  <button type="submit">🚀 開始分析</button>
</form>

<div class="result">
  <div id="loading">⏳ 正在分析中，請稍候...</div>
  <iframe id="resultFrame" name="resultFrame" onload="hideLoading()"></iframe>
</div>

</body>
</html>
