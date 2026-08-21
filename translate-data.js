/**
 * translate-data.js
 * Tự động dịch ItemsData_en.json → ItemsData_vn.json & ItemsData_zh.json
 * Sử dụng Google Translate miễn phí (không cần API key)
 * Chỉ dịch các item có Name/Desc chưa được dịch hoặc mới thêm vào
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

// ──────────────────────────────────────────────
// Config
// ──────────────────────────────────────────────
const EN_FILE  = path.join(__dirname, 'ItemsData_en.json');
const VN_FILE  = path.join(__dirname, 'ItemsData_vn.json');
const ZH_FILE  = path.join(__dirname, 'ItemsData_zh.json');

const BATCH_SIZE   = 50;   // Số item dịch mỗi batch (tránh rate limit)
const DELAY_MS     = 800;  // Delay giữa các request (ms)
const MAX_RETRIES  = 3;    // Số lần retry khi lỗi

// ──────────────────────────────────────────────
// Hàm sleep
// ──────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ──────────────────────────────────────────────
// Google Translate (unofficial, miễn phí)
// ──────────────────────────────────────────────
function translateText(text, targetLang) {
  return new Promise((resolve, reject) => {
    if (!text || !text.trim()) {
      resolve('');
      return;
    }

    const encodedText = encodeURIComponent(text);
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=${targetLang}&dt=t&q=${encodedText}`;

    const req = https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          // Ghép tất cả đoạn dịch lại
          let translated = '';
          if (parsed && parsed[0]) {
            for (const segment of parsed[0]) {
              if (segment && segment[0]) translated += segment[0];
            }
          }
          resolve(translated || text);
        } catch (e) {
          reject(new Error(`Parse error: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

// Retry wrapper
async function translateWithRetry(text, targetLang, retries = MAX_RETRIES) {
  for (let i = 0; i < retries; i++) {
    try {
      const result = await translateText(text, targetLang);
      return result;
    } catch (err) {
      console.warn(`  ⚠ Retry ${i + 1}/${retries} cho lang=${targetLang}: ${err.message}`);
      if (i < retries - 1) await sleep(DELAY_MS * (i + 1));
    }
  }
  return text; // Fallback: trả về text gốc nếu dịch thất bại
}

// ──────────────────────────────────────────────
// Dịch một item
// ──────────────────────────────────────────────
async function translateItem(enItem, existingItem, targetLang) {
  // Giữ nguyên các field không cần dịch
  const result = {
    Id:             enItem.Id,
    Type:           enItem.Type,
    CollectionType: enItem.CollectionType,
    Name:           existingItem?.Name ?? '',
    Desc:           existingItem?.Desc ?? '',
    Icon:           enItem.Icon,
    Rare:           enItem.Rare,
    IsUnique:       enItem.IsUnique,
    IconInAB:       enItem.IconInAB,
    Category:       enItem.Category,
    Tag:            enItem.Tag,
  };

  const enName = enItem.Name?.trim() || '';
  const enDesc = enItem.Desc?.trim() || '';
  const exName = existingItem?.Name?.trim() || '';
  const exDesc = existingItem?.Desc?.trim() || '';

  // Chỉ dịch nếu: item mới (không tồn tại) HOẶC bản dịch còn trống khi EN có nội dung
  const needTranslateName = enName && !exName;
  const needTranslateDesc = enDesc && !exDesc;

  if (needTranslateName) {
    result.Name = await translateWithRetry(enName, targetLang);
    await sleep(200);
  }

  if (needTranslateDesc) {
    result.Desc = await translateWithRetry(enDesc, targetLang);
    await sleep(200);
  }

  return result;
}

// ──────────────────────────────────────────────
// Xử lý một ngôn ngữ
// ──────────────────────────────────────────────
async function processLanguage(enData, existingData, targetLang, outputFile, langLabel) {
  console.log(`\n🌐 Đang xử lý: ${langLabel} (${targetLang})`);

  // Map existing data theo Id để tra cứu nhanh
  const existingMap = new Map();
  for (const item of existingData) {
    existingMap.set(item.Id, item);
  }

  const result = [];
  let translated = 0;
  let skipped    = 0;
  let newItems   = 0;

  for (let i = 0; i < enData.length; i += BATCH_SIZE) {
    const batch = enData.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(enData.length / BATCH_SIZE);
    console.log(`  📦 Batch ${batchNum}/${totalBatches} (items ${i + 1}–${Math.min(i + BATCH_SIZE, enData.length)})`);

    for (const enItem of batch) {
      const existing = existingMap.get(enItem.Id);
      const isNew = !existing;

      if (isNew) newItems++;

      const enName = enItem.Name?.trim() || '';
      const enDesc = enItem.Desc?.trim() || '';
      const exName = existing?.Name?.trim() || '';
      const exDesc = existing?.Desc?.trim() || '';

      const needsWork = (enName && !exName) || (enDesc && !exDesc);

      if (needsWork) {
        translated++;
        const translatedItem = await translateItem(enItem, existing, targetLang);
        result.push(translatedItem);
      } else {
        skipped++;
        // Giữ item existing nhưng sync lại các field không dịch (Icon, Rare, Category, Tag...)
        result.push({
          Id:             enItem.Id,
          Type:           enItem.Type,
          CollectionType: enItem.CollectionType,
          Name:           existing?.Name ?? '',
          Desc:           existing?.Desc ?? '',
          Icon:           enItem.Icon,
          Rare:           enItem.Rare,
          IsUnique:       enItem.IsUnique,
          IconInAB:       enItem.IconInAB,
          Category:       enItem.Category,
          Tag:            enItem.Tag,
        });
      }
    }

    // Delay giữa các batch
    if (i + BATCH_SIZE < enData.length) {
      await sleep(DELAY_MS);
    }
  }

  // Ghi file
  fs.writeFileSync(outputFile, JSON.stringify(result, null, 4), 'utf-8');

  console.log(`  ✅ Hoàn thành ${langLabel}:`);
  console.log(`     - Tổng item : ${result.length}`);
  console.log(`     - Mới thêm  : ${newItems}`);
  console.log(`     - Đã dịch   : ${translated}`);
  console.log(`     - Bỏ qua    : ${skipped}`);
  console.log(`     - Lưu vào   : ${outputFile}`);

  return { total: result.length, newItems, translated, skipped };
}

// ──────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────
async function main() {
  console.log('🚀 Bắt đầu dịch dữ liệu vật phẩm...\n');

  // Đọc dữ liệu nguồn
  if (!fs.existsSync(EN_FILE)) {
    console.error(`❌ Không tìm thấy file: ${EN_FILE}`);
    process.exit(1);
  }

  const enData = JSON.parse(fs.readFileSync(EN_FILE, 'utf-8'));
  console.log(`📂 Đọc ${enData.length} items từ ItemsData_en.json`);

  // Đọc dữ liệu dịch hiện có (nếu có)
  const vnData = fs.existsSync(VN_FILE) ? JSON.parse(fs.readFileSync(VN_FILE, 'utf-8')) : [];
  const zhData = fs.existsSync(ZH_FILE) ? JSON.parse(fs.readFileSync(ZH_FILE, 'utf-8')) : [];

  console.log(`📂 VN hiện có: ${vnData.length} items`);
  console.log(`📂 ZH hiện có: ${zhData.length} items`);

  // Kiểm tra có gì cần dịch không
  const vnMap = new Map(vnData.map(i => [i.Id, i]));
  const zhMap = new Map(zhData.map(i => [i.Id, i]));

  const vnNeeds = enData.filter(e => {
    const ex = vnMap.get(e.Id);
    return (e.Name?.trim() && !ex?.Name?.trim()) || (e.Desc?.trim() && !ex?.Desc?.trim());
  }).length;

  const zhNeeds = enData.filter(e => {
    const ex = zhMap.get(e.Id);
    return (e.Name?.trim() && !ex?.Name?.trim()) || (e.Desc?.trim() && !ex?.Desc?.trim());
  }).length;

  console.log(`\n📊 Cần dịch: VN=${vnNeeds} items | ZH=${zhNeeds} items`);

  if (vnNeeds === 0 && zhNeeds === 0 && vnData.length === enData.length && zhData.length === enData.length) {
    console.log('\n✨ Tất cả dữ liệu đã được dịch và đồng bộ. Không cần làm gì thêm.');
    // Vẫn sync lại để đảm bảo Category/Tag được cập nhật
  }

  const startTime = Date.now();

  // Xử lý VN
  const vnStats = await processLanguage(enData, vnData, 'vi', VN_FILE, 'Tiếng Việt');

  // Delay giữa 2 ngôn ngữ
  await sleep(1500);

  // Xử lý ZH
  const zhStats = await processLanguage(enData, zhData, 'zh-TW', ZH_FILE, 'Tiếng Trung (Traditional)');

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log('\n═══════════════════════════════════════');
  console.log('✅ HOÀN THÀNH DỊCH DỮ LIỆU');
  console.log(`   Thời gian: ${elapsed}s`);
  console.log(`   VN: ${vnStats.translated} dịch mới, ${vnStats.skipped} bỏ qua`);
  console.log(`   ZH: ${zhStats.translated} dịch mới, ${zhStats.skipped} bỏ qua`);
  console.log('═══════════════════════════════════════\n');
}

main().catch(err => {
  console.error('❌ Lỗi:', err);
  process.exit(1);
});
