const settings = require("../settings");
async function aliveCommand(sock, chatId, message) {
    try {
        const message1 = `*🤖 Stark Bot MD is Active!*\n\n` +
                       `*Version:* ${settings.version}\n` +
                       `*Status:* Online\n` +
                       `*Mode:* ${settings.commandMode || 'Public'}\n\n` +
                       `*🌟 Features:*\n` +
                       `• Group Management & Security\n` +
                       `• Anime Zone (Stream & 2GB Download)\n` +
                       `• Media Downloader (YT/Insta/TikTok/FB)\n` +
                       `• AI & Image Generation\n` +
                       `• Fun, Games & Textmaker\n\n` +
                       `Type *.menu* for full command list`;

        await sock.sendMessage(chatId, {
            text: message1,
            contextInfo: {
                forwardingScore: 999,
                isForwarded: true,
                forwardedNewsletterMessageInfo: {
                    newsletterJid: '120363427374371915@newsletter',
                    newsletterName: 'Stark Bot MD',
                    serverMessageId: -1
                }
            }
        }, { quoted: message });
    } catch (error) {
        console.error('Error in alive command:', error);
        await sock.sendMessage(chatId, { text: 'Bot is alive and running!' }, { quoted: message });
    }
}

module.exports = aliveCommand;