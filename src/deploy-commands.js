require('dotenv').config();
const { REST, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');
const logger = require('./utils/logger');

const commands = [];
const commandsPath = path.join(__dirname, 'commands');

if (fs.existsSync(commandsPath)) {
    const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));
    for (const file of commandFiles) {
        const filePath = path.join(commandsPath, file);
        const command = require(filePath);
        if ('data' in command && 'execute' in command) {
            commands.push(command.data.toJSON());
        }
    }
}

const rest = new REST().setToken(process.env.DISCORD_TOKEN);

(async () => {
    try {
        logger.info(`Đang đăng ký ${commands.length} lệnh (slash commands)...`);

        if (process.env.CLIENT_ID) {
            const data = await rest.put(
                Routes.applicationCommands(process.env.CLIENT_ID),
                { body: commands }
            );
            logger.info(`✅ Đã đăng ký thành công ${data.length} lệnh toàn cục (global commands).`);
        } else {
            logger.error('❌ Thiếu CLIENT_ID trong biến môi trường (.env)');
        }
    } catch (error) {
        logger.error(`❌ Lỗi đăng ký lệnh: ${error.message}`);
    }
})();
