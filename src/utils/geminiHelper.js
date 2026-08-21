/**
 * geminiHelper.js — Helper quản lý gọi Gemini API và tự động chuyển model khi hết quota
 * 
 * Hỗ trợ tự động chuyển đổi qua lại giữa các model khi gặp lỗi 429 (Too Many Requests / Quota Exceeded)
 * Có cơ chế cooldown để ưu tiên quay lại dùng các model tốt nhất sau khi chúng hồi phục RPM (Requests Per Minute).
 */

const logger = require('./logger');

// Danh sách các model AI dự phòng theo thứ tự ưu tiên
const DEFAULT_FALLBACK_MODELS = [
    'gemini-3.7-flash',
    'gemini-3.6-flash',
    'gemini-3.5-flash',
    'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite',
    'gemini-3-flash',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-2.0-flash',
    'gemini-1.5-flash'
];

// Lấy model ưu tiên cao nhất từ .env, nếu không có thì lấy phần tử đầu tiên
const PRIMARY_MODEL = process.env.GEMINI_MODEL || DEFAULT_FALLBACK_MODELS[0];

// Xây dựng danh sách model sẽ thử: đảm bảo PRIMARY_MODEL ở đầu
const modelsToTry = [PRIMARY_MODEL];
for (const model of DEFAULT_FALLBACK_MODELS) {
    if (!modelsToTry.includes(model)) {
        modelsToTry.push(model);
    }
}

// Lưu trữ thời gian model có thể được dùng lại (do bị lỗi 429)
const modelCooldowns = {};

// Biến lưu trạng thái model đang active, dùng để log khi thay đổi
let currentActiveModel = PRIMARY_MODEL;

/**
 * Gọi Gemini API với cơ chế tự động chuyển sang model dự phòng khi gặp lỗi 429
 * 
 * @param {object} requestBody - Body của request gửi đi
 * @returns {Promise<{data: any, modelUsed: string}|null>} Trả về data response từ API và model đã sử dụng thành công
 */
async function callGeminiWithFallback(requestBody) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        logger.error('[GeminiHelper] GEMINI_API_KEY chưa được cấu hình trong file .env!');
        return null;
    }

    const now = Date.now();
    
    // Lọc ra danh sách các model hiện không bị cooldown
    let availableModels = modelsToTry.filter(model => !modelCooldowns[model] || now > modelCooldowns[model]);
    
    if (availableModels.length === 0) {
        logger.warn('[GeminiHelper] ⚠️ Tất cả các model đều đang trong thời gian cooldown! Đang thử ép gọi lại...');
        availableModels = [...modelsToTry];
    }

    for (let i = 0; i < availableModels.length; i++) {
        const modelName = availableModels[i];
        
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;

        try {
            logger.info(`[GeminiHelper] Đang gọi API sử dụng model: ${modelName}`);
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(requestBody)
            });

            if (response.status === 429) {
                logger.warn(`[GeminiHelper] ⚠️ Model ${modelName} hết quota/RPM (Lỗi 429). Bắt đầu cooldown 60s và chuyển sang model khác...`);
                modelCooldowns[modelName] = Date.now() + 60 * 1000;
                continue;
            }

            if (!response.ok) {
                const errorText = await response.text();
                if (response.status === 401 || response.status === 403) {
                    logger.error(`[GeminiHelper] ❌ Sai API Key hoặc không có quyền truy cập API (${response.status}): ${errorText}`);
                    return null;
                }
                
                if (response.status === 404) {
                    logger.error(`[GeminiHelper] ❌ Model ${modelName} không tồn tại hoặc URL sai (${response.status}). Thử model khác...`);
                    modelCooldowns[modelName] = Date.now() + 5 * 60 * 1000;
                    continue;
                }
                
                if (response.status === 503) {
                    logger.warn(`[GeminiHelper] ⚠️ Máy chủ quá tải với model ${modelName} (Lỗi 503). Đang cooldown 10s...`);
                    modelCooldowns[modelName] = Date.now() + 10 * 1000;
                    continue;
                }

                logger.error(`[GeminiHelper] Lỗi khi gọi Gemini API với model ${modelName} (${response.status}): ${errorText}`);
                continue;
            }

            const data = await response.json();
            
            if (currentActiveModel !== modelName) {
                logger.info(`[GeminiHelper] 🔄 Đã đổi model hoạt động chính sang: ${modelName}`);
                currentActiveModel = modelName;
            }

            return { data, modelUsed: modelName };

        } catch (error) {
            logger.error(`[GeminiHelper] Lỗi kết nối khi gọi model ${modelName}: ${error.message}`);
        }
    }

    logger.error('[GeminiHelper] ❌ Tất cả các model AI đều thất bại hoặc đang bị limit!');
    return null;
}

module.exports = {
    callGeminiWithFallback,
    getActiveModel: () => currentActiveModel
};
