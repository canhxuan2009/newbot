/**
 * translator.js — Module dịch tự động thông báo DonutSMP (EN → VI)
 * 
 * Sử dụng Google AI Studio (Gemini API) để dịch nội dung tiếng Anh sang tiếng Việt chuẩn ngữ cảnh Minecraft.
 */

const logger = require('./logger');
const { callGeminiWithFallback } = require('./geminiHelper');

const SYSTEM_PROMPT = `MASTER PROMPT — AI DỊCH THÔNG BÁO DONUTSMP SANG TIẾNG VIỆT

VAI TRÒ:
Bạn là biên dịch viên chuyên nghiệp chuyên dịch thông báo kỹ thuật của server Minecraft DonutSMP từ tiếng Anh sang tiếng Việt.

NHIỆM VỤ:
Dịch nội dung do người dùng cung cấp từ tiếng Anh sang tiếng Việt tự nhiên, rõ ràng và chính xác chuẩn ngữ cảnh Minecraft DonutSMP.

QUY TẮC CỐT LÕI:
1. Chỉ dịch nội dung được cung cấp. Không tự ý thêm/bớt thông tin.
2. Dịch theo nghĩa và ngữ cảnh, không dịch máy móc từng từ.
3. Không làm thay đổi mức độ chắc chắn của thông báo.
4. Giữ nguyên lệnh (như /ah, /sell, /rtp), tên người dùng, IP, tọa độ, nội dung trong dấu backtick.
5. Thuật ngữ Minecraft: server -> server, bug -> lỗi, fix -> bản sửa lỗi, RTP -> RTP, TPS -> TPS, Nether -> Nether, The End -> The End, pearl -> ngọc Ender, restart -> khởi động lại server.
6. Xưng hô: I -> tôi, We -> chúng tôi, You -> bạn/các bạn.
7. GIỮ NGUYÊN ĐỊNH DẠNG Markdown (tiêu đề, in đậm, danh sách, dòng trống).
8. Chỉ trả về duy nhất bản dịch tiếng Việt, không kèm bất kỳ câu dẫn hay ghi chú nào khác.`;

/**
 * Dịch nội dung tiếng Anh sang tiếng Việt bằng Gemini API
 * 
 * @param {string} englishText - Nội dung tiếng Anh cần dịch
 * @returns {Promise<string|null>} Bản dịch tiếng Việt, hoặc null nếu lỗi
 */
async function translateToVietnamese(englishText) {
    if (!englishText || englishText.trim().length === 0) {
        logger.warn('[Translator] Nội dung rỗng, bỏ qua.');
        return null;
    }

    const requestBody = {
        systemInstruction: {
            parts: [
                {
                    text: SYSTEM_PROMPT
                }
            ]
        },
        contents: [
            {
                role: 'user',
                parts: [
                    {
                        text: englishText
                    }
                ]
            }
        ],
        generationConfig: {
            temperature: 0.3
        }
    };

    try {
        const result = await callGeminiWithFallback(requestBody);
        if (!result) {
            logger.error('[Translator] Không nhận được kết quả dịch từ Gemini Helper.');
            return null;
        }

        const { data, modelUsed } = result;
        const translatedText = data.candidates?.[0]?.content?.parts?.[0]?.text;

        if (!translatedText || translatedText.trim().length === 0) {
            logger.warn(`[Translator] Gemini (${modelUsed}) trả về kết quả rỗng.`);
            return null;
        }

        logger.info(`[Translator] Dịch thành công via Gemini ${modelUsed} (${englishText.length} → ${translatedText.length} ký tự)`);
        return translatedText.trim();

    } catch (error) {
        logger.error(`[Translator] ❌ Lỗi xử lý dịch: ${error.message}`);
        return null;
    }
}

module.exports = { translateToVietnamese };
