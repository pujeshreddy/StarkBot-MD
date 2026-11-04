/**
 * 🎌 Advanced Anime Command for Stark Bot MD
 * 
 * Features:
 * - Browse anime catalog (Latest, Series, Movies, Ongoing, Trending)
 * - Browse by genre (Action, Adventure, Comedy, Fantasy, Romance, Sci-Fi)
 * - Search anime by name
 * - Smart poster fetching from AniList & Kitsu (bypasses Cloudflare on imgbb/gokuhd)
 * - Full anime details: poster, synopsis, rating, tags, sources
 * - Season & quality selection
 * - Episode list with quick download indicators
 * - Remuxing (MKV -> WhatsApp-compliant MP4 with faststart) via ffmpeg
 * - Up to 2GB WhatsApp document support
 * - Multi-strategy upload (Playable video -> Document stream -> Buffer retry)
 * - Extended upload timeout (10 mins) to prevent "Media upload failed on all hosts"
 * 
 * Commands:
 *   .anime                    → Show main menu
 *   .anime latest / trending / ongoing / series / movies  → Browse catalog
 *   .anime genre <name>       → Browse by genre
 *   .anime search <query>     → Search for anime
 *   .anime page <number>      → Page navigation
 *   .anime info <number>      → Anime details with official poster
 *   .anime episodes <number>  → Episode list for selected quality
 *   .anime dl <number>        → Download episode directly to WhatsApp (up to 2GB)
 *   .anime clear              → Reset session
 */

const dns = require('dns');
// Ensure IPv4 first to prevent IPv6 network delays/timeouts on Linux
if (typeof dns.setDefaultResultOrder === 'function') {
    dns.setDefaultResultOrder('ipv4first');
}

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// ─── Constants ───────────────────────────────────────────────────────────────
const API_BASE = 'https://moviebeast.up.railway.app/api/gokuHD';
const TIMEOUT = 60000; // 60s for catalog and metadata
const STREAM_TIMEOUT = 75000; // 75s for stream scraper extraction
const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': '*/*'
};

// Max WhatsApp document limit (WhatsApp allows up to 2GB)
const MAX_WHATSAPP_DOC_SIZE = 2000 * 1024 * 1024; // 2 GB

// Upload timeout in milliseconds (15 minutes for large video uploads)
const UPLOAD_TIMEOUT_MS = 900000;

// Temp directory for anime files
const TEMP_DIR = path.join(process.cwd(), 'temp');
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// Per-chat session state (auto-expires after 15 minutes of inactivity)
const sessions = new Map();
const SESSION_TTL = 15 * 60 * 1000;

// ─── Channel info for messages ───────────────────────────────────────────────
const channelInfo = {
    forwardingScore: 1,
    isForwarded: true,
    forwardedNewsletterMessageInfo: {
        newsletterJid: '120363427374371915@newsletter',
        newsletterName: 'Stark Bot MD',
        serverMessageId: -1
    }
};

// ─── Session Management ──────────────────────────────────────────────────────

function getSession(chatId) {
    const s = sessions.get(chatId);
    if (s) {
        s.lastAccess = Date.now();
        return s;
    }
    return null;
}

function setSession(chatId, data) {
    data.lastAccess = Date.now();
    sessions.set(chatId, data);
}

function clearSession(chatId) {
    sessions.delete(chatId);
}

// Clean expired sessions periodically
const sessionCleanerTimer = setInterval(() => {
    const now = Date.now();
    for (const [chatId, session] of sessions) {
        if (now - session.lastAccess > SESSION_TTL) {
            sessions.delete(chatId);
        }
    }
}, 60000);
if (sessionCleanerTimer.unref) sessionCleanerTimer.unref();

// ─── Cleanup Helper ──────────────────────────────────────────────────────────

function cleanupFile(filePath) {
    if (filePath && fs.existsSync(filePath)) {
        try { fs.unlinkSync(filePath); } catch {}
    }
}

// ─── Title & Poster Helpers ──────────────────────────────────────────────────

function cleanTitle(title) {
    if (!title) return 'Anime';
    return title
        .replace(/\s*\|\s*\[.*?\]\s*/g, '')
        .replace(/\s*Hindi Dubbed.*$/i, '')
        .replace(/\s*WEB-DL.*$/i, '')
        .replace(/\s*Blu-Ray.*$/i, '')
        .trim();
}

function extractCoreAnimeTitle(title) {
    if (!title) return '';
    return title
        .replace(/\[.*?\]/g, '')
        .replace(/\(.*?\)/g, '')
        .replace(/Season\s*\d+/gi, '')
        .replace(/S\d+(\s*E\d+)?/gi, '')
        .replace(/Part\s*\d+/gi, '')
        .replace(/Hindi\s*Dubbed.*/gi, '')
        .replace(/Blu-?Ray.*/gi, '')
        .replace(/WEB-?DL.*/gi, '')
        .replace(/1080p|720p|480p|HD/gi, '')
        .replace(/\|.*/g, '')
        .replace(/-.*$/g, '')
        .replace(/[:–—]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Resolves a reliable poster image for an anime title.
 * Uses AniList & Kitsu GraphQL/REST APIs to fetch official posters,
 * completely avoiding Cloudflare 403 on imgbb.fit / gokuhd.cc.
 */
async function resolvePosterUrl(animeTitle, rawUrl) {
    const coreTitle = extractCoreAnimeTitle(animeTitle);

    // 1. Try AniList GraphQL (Fast, official, unrestricted CDN)
    if (coreTitle) {
        try {
            const res = await axios.post('https://graphql.anilist.co', {
                query: `query ($search: String) {
                    Media(search: $search, type: ANIME) {
                        coverImage { extraLarge large medium }
                    }
                }`,
                variables: { search: coreTitle }
            }, {
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                timeout: 5000
            });
            const cover = res.data?.data?.Media?.coverImage;
            const img = cover?.extraLarge || cover?.large || cover?.medium;
            if (img) return img;
        } catch (e) {
            // Continue to fallback
        }

        // 2. Try Kitsu API fallback
        try {
            const res = await axios.get(`https://kitsu.io/api/edge/anime?filter[text]=${encodeURIComponent(coreTitle)}&page[limit]=1`, { timeout: 5000 });
            const postImg = res.data?.data?.[0]?.attributes?.posterImage;
            const img = postImg?.large || postImg?.medium || postImg?.small || postImg?.original;
            if (img) return img;
        } catch (e) {
            // Continue to fallback
        }
    }

    // 3. Fallback to rawUrl if it's not imgbb.fit or gokuhd (which fail)
    if (rawUrl && !rawUrl.includes('imgbb.fit') && !rawUrl.includes('gokuhd.cc')) {
        return rawUrl;
    }

    return null;
}

/**
 * Downloads an image to a temporary file, ensuring it's valid.
 * Returns local file path or null.
 */
async function downloadPosterToTemp(imageUrl) {
    if (!imageUrl) return null;
    const tempFile = path.join(TEMP_DIR, `poster_${Date.now()}_${Math.floor(Math.random() * 1000)}.jpg`);
    try {
        const response = await axios({
            method: 'GET',
            url: imageUrl,
            responseType: 'stream',
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8'
            }
        });

        const writer = fs.createWriteStream(tempFile);
        response.data.pipe(writer);

        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });

        const stats = fs.statSync(tempFile);
        if (stats.size > 500) {
            return tempFile;
        }
        cleanupFile(tempFile);
        return null;
    } catch (e) {
        cleanupFile(tempFile);
        return null;
    }
}

/**
 * Sends a message with poster image if available, else text-only fallback.
 */
async function sendPosterOrTextMessage(sock, chatId, animeTitle, rawImageUrl, text, message) {
    try {
        const posterUrl = await resolvePosterUrl(animeTitle, rawImageUrl);
        if (posterUrl) {
            const tempPosterPath = await downloadPosterToTemp(posterUrl);
            if (tempPosterPath) {
                try {
                    await sock.sendMessage(chatId, {
                        image: { url: tempPosterPath },
                        caption: text,
                        contextInfo: channelInfo
                    }, { quoted: message });
                    cleanupFile(tempPosterPath);
                    return;
                } catch (sendErr) {
                    cleanupFile(tempPosterPath);
                }
            }
        }
    } catch (e) {
        // Fallback to text
    }

    // Text fallback
    await sock.sendMessage(chatId, {
        text,
        contextInfo: channelInfo
    }, { quoted: message });
}

// ─── API Wrappers ────────────────────────────────────────────────────────────

async function fetchCatalog() {
    try {
        const { data } = await axios.get(`${API_BASE}/catalog`, { headers: HEADERS, timeout: TIMEOUT });
        return data;
    } catch (err) {
        console.error('[anime] Catalog fetch error:', err.message);
        return null;
    }
}

async function fetchPosts(filter, page = 1) {
    try {
        const { data } = await axios.get(`${API_BASE}/posts`, {
            params: { filter, page },
            headers: HEADERS,
            timeout: TIMEOUT
        });
        return data;
    } catch (err) {
        console.error('[anime] Posts fetch error:', err.message);
        return null;
    }
}

async function fetchMeta(link) {
    try {
        const { data } = await axios.get(`${API_BASE}/meta`, {
            params: { link },
            headers: HEADERS,
            timeout: TIMEOUT
        });
        return data;
    } catch (err) {
        console.error('[anime] Meta fetch error:', err.message);
        return null;
    }
}

async function fetchEpisodes(url) {
    try {
        const { data } = await axios.get(`${API_BASE}/episodes`, {
            params: { url },
            headers: HEADERS,
            timeout: TIMEOUT
        });
        return data;
    } catch (err) {
        console.error('[anime] Episodes fetch error:', err.message);
        return null;
    }
}

async function fetchStream(link, type = 'movie', download = false, attempt = 1) {
    try {
        console.log(`[anime] Fetching stream (attempt ${attempt}, download=${download}):`, link);
        const { data } = await axios.get(`${API_BASE}/stream`, {
            params: { link, type, download },
            headers: HEADERS,
            timeout: STREAM_TIMEOUT
        });
        if (data && Array.isArray(data.streams) && data.streams.length > 0) {
            return data;
        }
        // If download=false returned empty streams, immediately try download=true
        if (!download) {
            console.log('[anime] download=false returned no streams, trying download=true...');
            return await fetchStream(link, type, true, attempt + 1);
        }
        return data;
    } catch (err) {
        console.error(`[anime] Stream fetch error (attempt ${attempt}):`, err.message);
        // If first attempt timed out or failed with download=false, retry with download=true
        if (attempt === 1 && !download) {
            console.log('[anime] Retrying stream fetch with download=true...');
            return await fetchStream(link, type, true, 2);
        }
        if (attempt < 3) {
            await new Promise(r => setTimeout(r, 2000));
            return await fetchStream(link, type, !download, attempt + 1);
        }
        return null;
    }
}

// ─── Video File Downloader & Remuxer ─────────────────────────────────────────

/**
 * Downloads video file via stream to avoid filling Node.js RAM.
 */
async function downloadVideoToFile(url, fileName) {
    const filePath = path.join(TEMP_DIR, fileName);

    const response = await axios({
        method: 'GET',
        url,
        responseType: 'stream',
        headers: {
            ...HEADERS,
            'Referer': 'https://gokuhd.cc/'
        },
        timeout: 900000 // 15 minutes max
    });

    const writer = fs.createWriteStream(filePath);
    response.data.pipe(writer);

    await new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', (err) => {
            cleanupFile(filePath);
            reject(err);
        });
    });

    const stats = fs.statSync(filePath);
    const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);

    return { filePath, sizeBytes: stats.size, sizeMB };
}

/**
 * Remuxes or converts a video (e.g. MKV) into WhatsApp-compatible MP4 with faststart.
 * Uses lib/waVideo.js or fallback direct ffmpeg stream copy.
 */
async function remuxToWhatsAppMp4(inputPath, outputPath) {
    // 1. Try toWhatsAppMp4 from lib/waVideo
    try {
        const { toWhatsAppMp4 } = require('../lib/waVideo');
        await toWhatsAppMp4(inputPath, outputPath);
        if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 1000) {
            return outputPath;
        }
    } catch (e) {
        console.log('[anime] toWhatsAppMp4 fallback:', e.message);
    }

    // 2. Direct ffmpeg stream-copy with +faststart (lightning fast, ~2 seconds)
    try {
        await new Promise((resolve, reject) => {
            const cp = spawn('ffmpeg', [
                '-y',
                '-i', inputPath,
                '-c', 'copy',
                '-movflags', '+faststart',
                outputPath
            ], { windowsHide: true });

            cp.on('close', code => {
                if (code === 0) resolve();
                else reject(new Error(`ffmpeg exited with code ${code}`));
            });
            cp.on('error', reject);
        });

        if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 1000) {
            return outputPath;
        }
    } catch (e2) {
        console.log('[anime] ffmpeg copy fallback:', e2.message);
    }

    // 3. Fallback to original
    return inputPath;
}

// ─── Formatters ──────────────────────────────────────────────────────────────

function buildMainMenu() {
    return `╔════════════════════════╗
   🎌 *ANIME ZONE* 🎌
   _Powered by Stark Bot MD_
╚════════════════════════╝

📂 *Browse Catalog:*
┃ ➤ \`.anime latest\`
┃ ➤ \`.anime trending\`
┃ ➤ \`.anime ongoing\`
┃ ➤ \`.anime series\`
┃ ➤ \`.anime movies\`

🎭 *Browse by Genre:*
┃ ➤ \`.anime genre action\`
┃ ➤ \`.anime genre adventure\`
┃ ➤ \`.anime genre comedy\`
┃ ➤ \`.anime genre fantasy\`
┃ ➤ \`.anime genre romance\`
┃ ➤ \`.anime genre sci-fi\`

🔍 *Search:*
┃ ➤ \`.anime search <name>\`
┃   _Example: .anime search bleach_

📌 *Download Flow:*
┃ ➤ \`.anime info <number>\`
┃   _Details & official poster_
┃ ➤ \`.anime episodes <number>\`
┃   _Select season/quality_
┃ ➤ \`.anime dl <number>\`
┃   _High-speed multi-worker download (up to 2GB!)_

⚙️ *Workers & Queue:*
┃ ➤ \`.anime workers\`
┃   _Check active download workers & queue_
┃ ➤ \`.anime cancel\`
┃   _Cancel your pending download_

⚡ *Sessions auto-save your progress for 15 minutes.*`;
}

function buildPostList(posts, title, page, total) {
    let msg = `╔════════════════════════╗\n   🎌 *${title}* — Page ${page}/${total}\n╚════════════════════════╝\n\n`;
    
    posts.forEach((post, i) => {
        const name = cleanTitle(post.title);
        msg += `*${i + 1}.* ${name}\n`;
    });

    msg += `\n━━━━━━━━━━━━━━━━━━━━━━━━`;
    msg += `\n📌 *Next:* \`.anime info <number>\` — View details`;
    if (page < total) msg += `\n📄 *Next Page:* \`.anime page ${page + 1}\``;
    if (page > 1) msg += `\n📄 *Prev Page:* \`.anime page ${page - 1}\``;
    
    return msg;
}

function buildMetaMessage(meta) {
    const m = meta;
    const title = cleanTitle(m.title);
    const stars = m.rating ? '⭐'.repeat(Math.min(Math.round(parseFloat(m.rating) / 2), 5)) : '';
    
    let msg = `╔════════════════════════╗\n   🎬 *ANIME DETAILS*\n╚════════════════════════╝\n\n`;
    msg += `📺 *Title:* ${title}\n`;
    msg += `🎭 *Type:* ${(m.type || 'Series').toUpperCase()}\n`;
    if (m.rating) msg += `⭐ *Rating:* ${m.rating}/10 ${stars}\n`;
    if (m.tags && m.tags.length > 0) msg += `🏷️ *Tags:* ${m.tags.join(', ')}\n`;
    if (m.synopsis) msg += `\n📖 *Synopsis:*\n_${m.synopsis}_\n`;

    if (m.linkList && m.linkList.length > 0) {
        msg += `\n━━━━━━━━━━━━━━━━━━━━━━━━\n`;
        msg += `💾 *Available Seasons & Qualities:*\n\n`;
        m.linkList.forEach((link, i) => {
            const quality = link.quality || 'HD';
            const linkTitle = link.title.replace(/Download\s+/i, '').trim();
            msg += `*${i + 1}.* 🔹 [${quality}] ${linkTitle}\n`;
        });
        msg += `\n📌 *Next:* \`.anime episodes <number>\`\n`;
        msg += `_Example: .anime episodes 1_`;
    }

    return msg;
}

function buildEpisodeList(episodes, title, quality) {
    let msg = `╔════════════════════════╗\n   📋 *EPISODE LIST*\n╚════════════════════════╝\n\n`;
    msg += `📺 *${cleanTitle(title)}*\n`;
    msg += `🎞️ *Quality:* ${quality}\n`;
    msg += `📊 *Total Episodes:* ${episodes.length}\n\n`;

    episodes.forEach((ep, i) => {
        const icon = ep.quickDownload ? '⚡' : '📥';
        msg += `*${i + 1}.* ${icon} ${ep.title}\n`;
    });

    msg += `\n━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `📌 *Download:* \`.anime dl <number>\`\n`;
    msg += `_Example: .anime dl 1 (Sends episode into chat!)_\n`;

    return msg;
}

// ─── Worker Pool & Queue Manager ────────────────────────────────────────────

// Initialize global counter for active anime workers
global.activeAnimeWorkers = 0;

class AnimeDownloadQueue {
    constructor(maxConcurrent = 2) {
        this.maxConcurrent = maxConcurrent;
        this.queue = [];
        this.activeJobs = new Map(); // jobId -> job
        this.userJobMap = new Map(); // chatId -> jobId
        this.nextWorkerId = 1;
    }

    get activeCount() {
        return this.activeJobs.size;
    }

    get queueCount() {
        return this.queue.length;
    }

    hasActiveOrQueuedJob(chatId) {
        return this.userJobMap.has(chatId);
    }

    getJobByChat(chatId) {
        const jobId = this.userJobMap.get(chatId);
        if (!jobId) return null;
        if (this.activeJobs.has(jobId)) {
            return { job: this.activeJobs.get(jobId), isQueued: false, position: 0 };
        }
        const qIndex = this.queue.findIndex(j => j.id === jobId);
        if (qIndex !== -1) {
            return { job: this.queue[qIndex], isQueued: true, position: qIndex + 1 };
        }
        return null;
    }

    cancelJob(chatId) {
        const existing = this.getJobByChat(chatId);
        if (!existing) return null;

        const { job, isQueued } = existing;
        if (isQueued) {
            this.queue = this.queue.filter(j => j.id !== job.id);
            this.userJobMap.delete(chatId);
            job.status = 'cancelled';
            return { job, cancelled: true, wasQueued: true };
        } else {
            job.status = 'cancelled';
            if (job.abortController) {
                try { job.abortController.abort(); } catch {}
            }
            if (job.cleanFilePaths && Array.isArray(job.cleanFilePaths)) {
                for (const p of job.cleanFilePaths) {
                    cleanupFile(p);
                }
            }
            this.activeJobs.delete(job.id);
            this.userJobMap.delete(chatId);
            global.activeAnimeWorkers = this.activeJobs.size;
            this.processNext();
            return { job, cancelled: true, wasQueued: false };
        }
    }

    enqueue(jobData) {
        const job = {
            id: `anime_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
            ...jobData,
            status: 'queued',
            createdAt: Date.now(),
            workerId: null,
            cleanFilePaths: [],
            abortController: new AbortController()
        };

        this.userJobMap.set(job.chatId, job.id);

        if (this.activeJobs.size < this.maxConcurrent) {
            this.startJob(job);
            return { queued: false, job, queuePosition: 0 };
        } else {
            this.queue.push(job);
            const position = this.queue.length;
            return { queued: true, job, queuePosition: position };
        }
    }

    async startJob(job) {
        const workerId = this.nextWorkerId++;
        job.workerId = workerId;
        job.status = 'active';
        this.activeJobs.set(job.id, job);
        global.activeAnimeWorkers = this.activeJobs.size;

        try {
            await executeDownloadJob(job);
        } catch (err) {
            console.error(`[anime-worker #${workerId}] Unexpected error:`, err);
        } finally {
            this.activeJobs.delete(job.id);
            this.userJobMap.delete(job.chatId);
            global.activeAnimeWorkers = this.activeJobs.size;
            if (global.gc) global.gc();
            this.processNext();
        }
    }

    processNext() {
        if (this.queue.length > 0 && this.activeJobs.size < this.maxConcurrent) {
            const nextJob = this.queue.shift();
            if (nextJob && nextJob.status !== 'cancelled') {
                this.startJob(nextJob);
            }
        }
    }

    getStatusSummary() {
        const activeList = Array.from(this.activeJobs.values()).map(j => ({
            workerId: j.workerId,
            anime: j.animeName,
            episode: j.episode?.title || 'Unknown Episode',
            quality: j.quality,
            status: j.status,
            sizeMB: j.sizeMB || 'Calculating...',
            startedAt: j.startedAt
        }));

        const queueList = this.queue.map((j, idx) => ({
            position: idx + 1,
            anime: j.animeName,
            episode: j.episode?.title || 'Unknown Episode',
            quality: j.quality
        }));

        return {
            activeCount: this.activeJobs.size,
            maxConcurrent: this.maxConcurrent,
            activeList,
            queueCount: this.queue.length,
            queueList
        };
    }
}

const downloadWorkerQueue = new AnimeDownloadQueue(2);

/**
 * Executes a single anime download job through extraction, download, faststart remux, and WhatsApp upload.
 */
async function executeDownloadJob(job) {
    const { sock, chatId, message, episode, animeName, quality, workerId } = job;
    job.startedAt = Date.now();

    try {
        if (job.status === 'cancelled') return;

        // Step 1: Notify user worker has started
        job.status = 'extracting';
        await sock.sendMessage(chatId, {
            text: `⚙️ *[Worker #${workerId}] Started Download*\n📺 *Anime:* ${animeName}\n🎬 *${episode.title}* [${quality}]\n\n⏳ _Extracting high-speed stream link..._`,
            contextInfo: channelInfo
        }, { quoted: message });

        // Step 2: Extract stream URL (75s timeout with automatic download=true fallback)
        const streamData = await fetchStream(episode.link, 'movie', false);
        if (job.status === 'cancelled') return;

        if (!streamData || !streamData.streams || streamData.streams.length === 0) {
            await sock.sendMessage(chatId, {
                text: `❌ *[Worker #${workerId}]* Failed to extract stream URL.\n💡 The mirror server might be busy or spinning down. Please pick another episode or season via \`.anime episodes\`.`,
                contextInfo: channelInfo
            }, { quoted: message });
            return;
        }

        const stream = streamData.streams[0];
        const streamUrl = stream.link;
        const fileType = (stream.type || 'mp4').toLowerCase();

        if (!streamUrl) {
            await sock.sendMessage(chatId, {
                text: `❌ *[Worker #${workerId}]* No direct stream link found for this episode.`,
                contextInfo: channelInfo
            }, { quoted: message });
            return;
        }

        // Step 3: Stream download to server disk
        job.status = 'downloading';
        const cleanFileBase = `${animeName}_${episode.title}_${quality}`.replace(/[^a-zA-Z0-9_-]/g, '_');
        const rawFileName = `${job.id}_raw.${fileType}`;

        await sock.sendMessage(chatId, {
            text: `📥 *[Worker #${workerId}] Downloading to Server*\n📺 *${animeName}* — ${episode.title}\n\n⏳ _Streaming file to disk (supports up to 2GB)..._`,
            contextInfo: channelInfo
        }, { quoted: message });

        let downloadInfo;
        try {
            downloadInfo = await downloadVideoToFile(streamUrl, rawFileName);
        } catch (err) {
            if (job.status === 'cancelled') return;
            console.error(`[anime-worker #${workerId}] Download failed:`, err.message);
            await sock.sendMessage(chatId, {
                text: `⚠️ *[Worker #${workerId}] Download Failed:* ${err.message}\n\n🔗 *Direct Stream Link:*\n${streamUrl}\n\n📺 ${animeName} — ${episode.title}`,
                contextInfo: channelInfo
            }, { quoted: message });
            return;
        }

        const { filePath: rawFilePath, sizeBytes, sizeMB } = downloadInfo;
        job.cleanFilePaths.push(rawFilePath);
        job.sizeMB = sizeMB;

        if (job.status === 'cancelled') return;

        // Check WhatsApp's absolute 2GB document limit
        if (sizeBytes > MAX_WHATSAPP_DOC_SIZE) {
            cleanupFile(rawFilePath);
            await sock.sendMessage(chatId, {
                text: `⚠️ *File exceeds WhatsApp's 2GB document limit* (${sizeMB}MB)\n\n🔗 *Direct Download Link:*\n${streamUrl}\n\n📺 ${animeName} — ${episode.title} [${quality}]`,
                contextInfo: channelInfo
            }, { quoted: message });
            return;
        }

        // Step 4: Check if remuxing is needed (MKV or non-faststart MP4)
        job.status = 'processing';
        let sendFilePath = rawFilePath;
        const finalFileName = `${cleanFileBase}.mp4`;

        if (fileType === 'mkv' || !rawFilePath.endsWith('.mp4')) {
            const mp4Output = path.join(TEMP_DIR, `${job.id}.mp4`);
            const convertedPath = await remuxToWhatsAppMp4(rawFilePath, mp4Output);
            if (convertedPath && fs.existsSync(convertedPath)) {
                sendFilePath = convertedPath;
                job.cleanFilePaths.push(convertedPath);
                // Immediately delete raw file to preserve disk space
                if (convertedPath !== rawFilePath) {
                    cleanupFile(rawFilePath);
                }
            }
        }

        const sendStats = fs.statSync(sendFilePath);
        const sendSizeMB = (sendStats.size / (1024 * 1024)).toFixed(2);
        job.sizeMB = sendSizeMB;

        if (job.status === 'cancelled') return;

        // Step 5: Upload to WhatsApp
        job.status = 'uploading';
        await sock.sendMessage(chatId, {
            text: `📤 *[Worker #${workerId}] Uploading to WhatsApp (${sendSizeMB}MB)...*\n_Sending episode to chat. Please wait a moment!_`,
            contextInfo: channelInfo
        }, { quoted: message });

        const caption = `🎌 *${animeName}*\n📺 *${episode.title}* [${quality}]\n📊 Size: ${sendSizeMB}MB\n\n> _Processed by Worker #${workerId} • Stark Bot MD_ ⚡`;

        let sentSuccessfully = false;
        let lastUploadError = null;

        // Strategy 1: Files <= 64MB - send as playable video in chat
        if (sendStats.size <= 64 * 1024 * 1024) {
            try {
                await sock.sendMessage(chatId, {
                    video: { url: sendFilePath },
                    mimetype: 'video/mp4',
                    fileName: finalFileName,
                    caption,
                    contextInfo: channelInfo
                }, { quoted: message, mediaUploadTimeoutMs: UPLOAD_TIMEOUT_MS });
                sentSuccessfully = true;
            } catch (vErr) {
                console.log(`[anime-worker #${workerId}] Video bubble send failed, trying document:`, vErr.message);
                lastUploadError = vErr;
            }
        }

        // Strategy 2: Document upload up to 2GB with video/mp4 MIME type
        // Always sends as 'video/mp4' so WhatsApp displays the native "MP4" badge and plays in-app
        if (!sentSuccessfully) {
            try {
                await sock.sendMessage(chatId, {
                    document: { url: sendFilePath },
                    mimetype: 'video/mp4',
                    fileName: finalFileName,
                    caption,
                    contextInfo: channelInfo
                }, { quoted: message, mediaUploadTimeoutMs: UPLOAD_TIMEOUT_MS });
                sentSuccessfully = true;
            } catch (dErr) {
                console.log(`[anime-worker #${workerId}] Document url upload failed:`, dErr.message);
                lastUploadError = dErr;
            }
        }

        // Strategy 3: Stream fallback via fs.createReadStream with video/mp4
        if (!sentSuccessfully) {
            try {
                console.log(`[anime-worker #${workerId}] Retrying document via fs.createReadStream...`);
                await sock.sendMessage(chatId, {
                    document: fs.createReadStream(sendFilePath),
                    mimetype: 'video/mp4',
                    fileName: finalFileName,
                    caption,
                    contextInfo: channelInfo
                }, { quoted: message, mediaUploadTimeoutMs: UPLOAD_TIMEOUT_MS });
                sentSuccessfully = true;
            } catch (sErr) {
                console.log(`[anime-worker #${workerId}] ReadStream upload failed:`, sErr.message);
                lastUploadError = sErr;
            }
        }

        // Strategy 4: If <= 90MB and still failed, buffer retry with video/mp4
        if (!sentSuccessfully && sendStats.size <= 90 * 1024 * 1024) {
            try {
                console.log(`[anime-worker #${workerId}] Retrying upload via Buffer...`);
                const fileBuffer = fs.readFileSync(sendFilePath);
                await sock.sendMessage(chatId, {
                    document: fileBuffer,
                    mimetype: 'video/mp4',
                    fileName: finalFileName,
                    caption,
                    contextInfo: channelInfo
                }, { quoted: message, mediaUploadTimeoutMs: UPLOAD_TIMEOUT_MS });
                sentSuccessfully = true;
            } catch (bErr) {
                console.log(`[anime-worker #${workerId}] Buffer upload failed:`, bErr.message);
                lastUploadError = bErr;
            }
        }

        // Strategy 5: Fallback with application/octet-stream only if WhatsApp rejected video/mp4
        if (!sentSuccessfully) {
            try {
                console.log(`[anime-worker #${workerId}] Retrying document with octet-stream fallback...`);
                await sock.sendMessage(chatId, {
                    document: { url: sendFilePath },
                    mimetype: 'application/octet-stream',
                    fileName: finalFileName,
                    caption,
                    contextInfo: channelInfo
                }, { quoted: message, mediaUploadTimeoutMs: UPLOAD_TIMEOUT_MS });
                sentSuccessfully = true;
            } catch (fbErr) {
                console.log(`[anime-worker #${workerId}] Octet-stream fallback upload failed:`, fbErr.message);
                lastUploadError = fbErr;
            }
        }

        // Strategy 6: If all uploads failed, provide direct high-speed download link
        if (!sentSuccessfully) {
            await sock.sendMessage(chatId, {
                text: `⚠️ *[Worker #${workerId}] WhatsApp upload failed:* ${lastUploadError?.message || 'Media upload error'}\n\n🔗 *Direct Download Link:*\n${streamUrl}\n\n📺 ${animeName} — ${episode.title} [${quality}]\n📊 File Size: ${sendSizeMB}MB\n\n💡 _Open the link in your browser to watch or download._`,
                contextInfo: channelInfo
            }, { quoted: message });
        } else {
            job.status = 'done';
        }

    } catch (err) {
        console.error(`[anime-worker #${workerId}] Job execution error:`, err);
        try {
            await sock.sendMessage(chatId, {
                text: `❌ *[Worker #${workerId}] Error processing episode:* ${err.message || 'Unknown error'}\n💡 Please try again later.`,
                contextInfo: channelInfo
            }, { quoted: message });
        } catch {}
    } finally {
        for (const f of job.cleanFilePaths) {
            cleanupFile(f);
        }
        job.cleanFilePaths = [];
    }
}

// ─── Main Anime Command Handler ──────────────────────────────────────────────

async function animeDownloadCommand(sock, chatId, message, args) {
    try {
        const sub = (args[0] || '').toLowerCase();
        const rest = args.slice(1).join(' ').trim();

        // ── No args → Main Menu ──
        if (!sub) {
            await sock.sendMessage(chatId, {
                text: buildMainMenu(),
                contextInfo: channelInfo
            }, { quoted: message });
            return;
        }

        // ── Catalog Browse ──
        const catalogMap = {
            'latest': '',
            'series': 'series',
            'movies': 'movies',
            'ongoing': 'ongoing-series',
            'trending': 'trending'
        };

        if (catalogMap.hasOwnProperty(sub)) {
            await sock.sendMessage(chatId, {
                text: '🔍 _Browsing anime catalog..._',
                contextInfo: channelInfo
            }, { quoted: message });

            const filter = catalogMap[sub];
            const data = await fetchPosts(filter, 1);

            if (!data || !data.posts || data.posts.length === 0) {
                await sock.sendMessage(chatId, {
                    text: '❌ No anime found in this category.',
                    contextInfo: channelInfo
                }, { quoted: message });
                return;
            }

            setSession(chatId, {
                type: 'browse',
                filter,
                page: data.page || 1,
                totalPages: data.total || 1,
                posts: data.posts,
                title: sub.charAt(0).toUpperCase() + sub.slice(1)
            });

            const listMsg = buildPostList(data.posts, sub.charAt(0).toUpperCase() + sub.slice(1), data.page || 1, data.total || 1);
            const firstPost = data.posts[0];
            await sendPosterOrTextMessage(sock, chatId, firstPost?.title, firstPost?.image, listMsg, message);
            return;
        }

        // ── Genre Browse ──
        if (sub === 'genre') {
            const genreMap = {
                'action': 'genres/action',
                'adventure': 'genres/adventure',
                'comedy': 'genres/comedy',
                'fantasy': 'genres/fantasy',
                'romance': 'genres/romance',
                'sci-fi': 'genres/sci%e2%80%91fi',
                'scifi': 'genres/sci%e2%80%91fi'
            };

            const genreName = rest.toLowerCase();
            if (!genreName || !genreMap[genreName]) {
                const available = Object.keys(genreMap).filter(g => g !== 'scifi').join(', ');
                await sock.sendMessage(chatId, {
                    text: `🎭 *Available Genres:*\n${available}\n\n📌 Usage: \`.anime genre <name>\`\nExample: \`.anime genre action\``,
                    contextInfo: channelInfo
                }, { quoted: message });
                return;
            }

            await sock.sendMessage(chatId, {
                text: `🎭 _Browsing ${genreName} anime..._`,
                contextInfo: channelInfo
            }, { quoted: message });

            const filter = genreMap[genreName];
            const data = await fetchPosts(filter, 1);

            if (!data || !data.posts || data.posts.length === 0) {
                await sock.sendMessage(chatId, {
                    text: `❌ No anime found for genre: ${genreName}`,
                    contextInfo: channelInfo
                }, { quoted: message });
                return;
            }

            setSession(chatId, {
                type: 'browse',
                filter,
                page: data.page || 1,
                totalPages: data.total || 1,
                posts: data.posts,
                title: `Genre: ${genreName.charAt(0).toUpperCase() + genreName.slice(1)}`
            });

            const listMsg = buildPostList(data.posts, `Genre: ${genreName.charAt(0).toUpperCase() + genreName.slice(1)}`, data.page || 1, data.total || 1);
            const firstPost = data.posts[0];
            await sendPosterOrTextMessage(sock, chatId, firstPost?.title, firstPost?.image, listMsg, message);
            return;
        }

        // ── Search ──
        if (sub === 'search' || sub === 'find' || sub === 's') {
            if (!rest) {
                await sock.sendMessage(chatId, {
                    text: '🔍 *Usage:* `.anime search <anime name>`\n_Example: .anime search bleach_',
                    contextInfo: channelInfo
                }, { quoted: message });
                return;
            }

            await sock.sendMessage(chatId, {
                text: `🔍 _Searching for "${rest}"..._`,
                contextInfo: channelInfo
            }, { quoted: message });

            const results = [];
            const searchLower = rest.toLowerCase();

            // Search across latest
            for (let page = 1; page <= 3 && results.length < 12; page++) {
                const data = await fetchPosts('', page);
                if (data && data.posts) {
                    for (const post of data.posts) {
                        if (post.title.toLowerCase().includes(searchLower)) {
                            results.push(post);
                        }
                    }
                }
            }

            // Search series
            for (let page = 1; page <= 2 && results.length < 12; page++) {
                const data = await fetchPosts('series', page);
                if (data && data.posts) {
                    for (const post of data.posts) {
                        if (post.title.toLowerCase().includes(searchLower) && 
                            !results.some(r => r.link === post.link)) {
                            results.push(post);
                        }
                    }
                }
            }

            // Search movies
            const moviesData = await fetchPosts('movies', 1);
            if (moviesData && moviesData.posts) {
                for (const post of moviesData.posts) {
                    if (post.title.toLowerCase().includes(searchLower) && 
                        !results.some(r => r.link === post.link)) {
                        results.push(post);
                    }
                }
            }

            if (results.length === 0) {
                await sock.sendMessage(chatId, {
                    text: `❌ No anime found matching "${rest}".\n\n💡 *Tips:*\n• Try a shorter name (e.g. .anime search naruto)\n• Or browse categories: \`.anime latest\``,
                    contextInfo: channelInfo
                }, { quoted: message });
                return;
            }

            setSession(chatId, {
                type: 'search',
                posts: results,
                query: rest,
                title: `Search: "${rest}"`
            });

            let msg = `╔════════════════════════╗\n   🔍 *SEARCH RESULTS*\n   _Query: "${rest}"_\n╚════════════════════════╝\n\n`;
            msg += `📊 *Found ${results.length} result(s)*\n\n`;
            results.forEach((post, i) => {
                msg += `*${i + 1}.* ${cleanTitle(post.title)}\n`;
            });
            msg += `\n━━━━━━━━━━━━━━━━━━━━━━━━\n`;
            msg += `📌 *Next:* \`.anime info <number>\` — View details`;

            await sendPosterOrTextMessage(sock, chatId, results[0]?.title, results[0]?.image, msg, message);
            return;
        }

        // ── Page Navigation ──
        if (sub === 'page' || sub === 'p') {
            const session = getSession(chatId);
            if (!session || session.type !== 'browse') {
                await sock.sendMessage(chatId, {
                    text: '❌ No active browse session. Start browsing first!\n\nExample: `.anime latest`',
                    contextInfo: channelInfo
                }, { quoted: message });
                return;
            }

            const pageNum = parseInt(rest) || (session.page + 1);
            if (pageNum < 1 || pageNum > session.totalPages) {
                await sock.sendMessage(chatId, {
                    text: `❌ Invalid page. Available: 1-${session.totalPages}`,
                    contextInfo: channelInfo
                }, { quoted: message });
                return;
            }

            await sock.sendMessage(chatId, {
                text: `📄 _Loading page ${pageNum}..._`,
                contextInfo: channelInfo
            }, { quoted: message });

            const data = await fetchPosts(session.filter, pageNum);
            if (!data || !data.posts || data.posts.length === 0) {
                await sock.sendMessage(chatId, {
                    text: '❌ No more results on this page.',
                    contextInfo: channelInfo
                }, { quoted: message });
                return;
            }

            session.page = pageNum;
            session.posts = data.posts;
            setSession(chatId, session);

            const listMsg = buildPostList(data.posts, session.title, pageNum, session.totalPages);
            await sendPosterOrTextMessage(sock, chatId, data.posts[0]?.title, data.posts[0]?.image, listMsg, message);
            return;
        }

        // ── Info (Anime Details + Official Poster) ──
        if (sub === 'info' || sub === 'i' || sub === 'details') {
            const session = getSession(chatId);
            if (!session || !session.posts) {
                await sock.sendMessage(chatId, {
                    text: '❌ No anime list active.\n\nFirst browse or search:\n• `.anime latest`\n• `.anime search bleach`',
                    contextInfo: channelInfo
                }, { quoted: message });
                return;
            }

            const num = parseInt(rest);
            if (!num || num < 1 || num > session.posts.length) {
                await sock.sendMessage(chatId, {
                    text: `❌ Invalid number. Pick between 1 and ${session.posts.length}`,
                    contextInfo: channelInfo
                }, { quoted: message });
                return;
            }

            const selected = session.posts[num - 1];

            await sock.sendMessage(chatId, {
                text: `⏳ _Fetching details for: ${cleanTitle(selected.title)}..._`,
                contextInfo: channelInfo
            }, { quoted: message });

            const metaData = await fetchMeta(selected.link);
            if (!metaData || !metaData.meta) {
                await sock.sendMessage(chatId, {
                    text: '❌ Failed to fetch anime details. Please try again.',
                    contextInfo: channelInfo
                }, { quoted: message });
                return;
            }

            const meta = metaData.meta;

            // Store in session
            setSession(chatId, {
                ...session,
                type: 'meta',
                currentMeta: meta,
                selectedPost: selected
            });

            const metaMsg = buildMetaMessage(meta);

            // Send with official anime poster (AniList / Kitsu fallback)
            await sendPosterOrTextMessage(sock, chatId, meta.title || selected.title, meta.image || selected.image, metaMsg, message);
            return;
        }

        // ── Episodes List ──
        if (sub === 'episodes' || sub === 'ep' || sub === 'eps') {
            const session = getSession(chatId);
            if (!session || !session.currentMeta) {
                await sock.sendMessage(chatId, {
                    text: '❌ No anime selected yet.\n\nFollow these steps:\n1. `.anime latest` (Browse)\n2. `.anime info <number>` (Select)\n3. `.anime episodes <number>` (Pick quality)',
                    contextInfo: channelInfo
                }, { quoted: message });
                return;
            }

            const meta = session.currentMeta;
            if (!meta.linkList || meta.linkList.length === 0) {
                await sock.sendMessage(chatId, {
                    text: '❌ No download links available for this anime.',
                    contextInfo: channelInfo
                }, { quoted: message });
                return;
            }

            const num = parseInt(rest);
            if (!num || num < 1 || num > meta.linkList.length) {
                await sock.sendMessage(chatId, {
                    text: `❌ Invalid selection. Pick a number between 1 and ${meta.linkList.length}\n_Run \`.anime info\` again to see the list._`,
                    contextInfo: channelInfo
                }, { quoted: message });
                return;
            }

            const selectedLink = meta.linkList[num - 1];

            await sock.sendMessage(chatId, {
                text: `📋 _Loading episode list for [${selectedLink.quality || 'HD'}]..._`,
                contextInfo: channelInfo
            }, { quoted: message });

            let episodes = [];

            if (selectedLink.directLinks && selectedLink.directLinks.length > 0) {
                episodes = selectedLink.directLinks.map((dl, i) => ({
                    title: dl.title || `Episode ${i + 1}`,
                    link: dl.link || dl.url,
                    quickDownload: true
                }));
            } else if (selectedLink.episodesLink) {
                const epData = await fetchEpisodes(selectedLink.episodesLink);
                if (epData && epData.episodes) {
                    episodes = epData.episodes;
                }
            }

            if (episodes.length === 0) {
                await sock.sendMessage(chatId, {
                    text: '❌ No episodes found for this source. Try picking another source number!',
                    contextInfo: channelInfo
                }, { quoted: message });
                return;
            }

            setSession(chatId, {
                ...session,
                type: 'episodes',
                episodes,
                selectedQuality: selectedLink.quality || 'HD',
                selectedLinkTitle: selectedLink.title
            });

            const epMsg = buildEpisodeList(episodes, meta.title, selectedLink.quality || 'HD');
            await sock.sendMessage(chatId, {
                text: epMsg,
                contextInfo: channelInfo
            }, { quoted: message });
            return;
        }

        // ── Download/Stream Episode (Worker Pool & Queue up to 2GB) ──
        if (sub === 'dl' || sub === 'download' || sub === 'watch' || sub === 'stream') {
            const session = getSession(chatId);
            if (!session || !session.episodes) {
                await sock.sendMessage(chatId, {
                    text: '❌ No episode list active.\n\nFlow:\n1. `.anime latest`\n2. `.anime info <number>`\n3. `.anime episodes <number>`\n4. `.anime dl <number>`',
                    contextInfo: channelInfo
                }, { quoted: message });
                return;
            }

            const num = parseInt(rest);
            if (!num || num < 1 || num > session.episodes.length) {
                await sock.sendMessage(chatId, {
                    text: `❌ Invalid episode number. Pick between 1 and ${session.episodes.length}`,
                    contextInfo: channelInfo
                }, { quoted: message });
                return;
            }

            // Check if this chat already has a download in progress or queue
            if (downloadWorkerQueue.hasActiveOrQueuedJob(chatId)) {
                const existing = downloadWorkerQueue.getJobByChat(chatId);
                const statusText = existing?.isQueued ? `in Queue (Position #${existing.position})` : `Active in Worker #${existing?.job?.workerId || 1}`;
                await sock.sendMessage(chatId, {
                    text: `⚠️ *You already have a download ${statusText}!*\n📺 *${existing?.job?.animeName || 'Anime'}* — ${existing?.job?.episode?.title || 'Episode'}\n\n💡 Please wait for it to finish, or cancel it using \`.anime cancel\`.`,
                    contextInfo: channelInfo
                }, { quoted: message });
                return;
            }

            const episode = session.episodes[num - 1];
            const animeName = cleanTitle(session.currentMeta?.title || 'Anime');
            const quality = session.selectedQuality || 'HD';

            // Enqueue download task in the worker pool
            const result = downloadWorkerQueue.enqueue({
                sock,
                chatId,
                message,
                episode,
                animeName,
                quality
            });

            if (result.queued) {
                await sock.sendMessage(chatId, {
                    text: `📥 *Added to Download Queue!*\n\n📺 *Anime:* ${animeName}\n🎬 *${episode.title}* [${quality}]\n📋 *Queue Position:* #${result.queuePosition}\n⚙️ *Active Workers:* ${downloadWorkerQueue.activeCount}/${downloadWorkerQueue.maxConcurrent}\n\n💡 _Stark Bot will automatically start downloading and send your episode when a worker becomes available!_\n_To cancel anytime, use \`.anime cancel\`._`,
                    contextInfo: channelInfo
                }, { quoted: message });
            }
            return;
        }

        // ── Check Workers & Download Queue ──
        if (sub === 'workers' || sub === 'queue' || sub === 'status') {
            const summary = downloadWorkerQueue.getStatusSummary();
            let statusMsg = `╔════════════════════════╗\n   ⚙️ *DOWNLOAD WORKERS & QUEUE*\n╚════════════════════════╝\n\n`;
            statusMsg += `🟢 *Active Workers:* ${summary.activeCount}/${summary.maxConcurrent}\n`;
            if (summary.activeList.length === 0) {
                statusMsg += `┃ _All workers are currently idle (Ready!)_\n`;
            } else {
                summary.activeList.forEach((w) => {
                    statusMsg += `┃ 🔹 *Worker #${w.workerId}:* ${w.anime} — ${w.episode}\n┃    _Status:_ ${w.status.toUpperCase()} (${w.sizeMB})\n`;
                });
            }

            statusMsg += `\n📋 *Waiting Queue:* ${summary.queueCount} job(s)\n`;
            if (summary.queueList.length === 0) {
                statusMsg += `┃ _Queue is empty_\n`;
            } else {
                summary.queueList.forEach((q) => {
                    statusMsg += `┃ *#${q.position}.* ${q.anime} — ${q.episode} [${q.quality}]\n`;
                });
            }

            statusMsg += `\n━━━━━━━━━━━━━━━━━━━━━━━━\n💡 _Use \`.anime cancel\` to cancel your download._`;

            await sock.sendMessage(chatId, {
                text: statusMsg,
                contextInfo: channelInfo
            }, { quoted: message });
            return;
        }

        // ── Cancel Queued / Active Download ──
        if (sub === 'cancel' || sub === 'stop' || sub === 'abort') {
            const cancelRes = downloadWorkerQueue.cancelJob(chatId);
            if (!cancelRes) {
                await sock.sendMessage(chatId, {
                    text: `ℹ️ You do not have any active or queued anime downloads.`,
                    contextInfo: channelInfo
                }, { quoted: message });
                return;
            }

            if (cancelRes.wasQueued) {
                await sock.sendMessage(chatId, {
                    text: `✅ *Download Cancelled!*\nYour queued download for *${cancelRes.job.animeName} — ${cancelRes.job.episode.title}* was removed from the queue.`,
                    contextInfo: channelInfo
                }, { quoted: message });
            } else {
                await sock.sendMessage(chatId, {
                    text: `🛑 *Active Download Aborted!*\nStopped download for *${cancelRes.job.animeName} — ${cancelRes.job.episode.title}*.`,
                    contextInfo: channelInfo
                }, { quoted: message });
            }
            return;
        }

        // ── Clear Session ──
        if (sub === 'clear' || sub === 'reset') {
            clearSession(chatId);
            await sock.sendMessage(chatId, {
                text: '✅ Anime session cleared! Start fresh with `.anime`',
                contextInfo: channelInfo
            }, { quoted: message });
            return;
        }

        // ── Unknown Subcommand ──
        await sock.sendMessage(chatId, {
            text: `❌ Unknown command: \`.anime ${sub}\`\n\n` + buildMainMenu(),
            contextInfo: channelInfo
        }, { quoted: message });

    } catch (err) {
        console.error('[anime] Command error:', err);
        await sock.sendMessage(chatId, {
            text: `❌ An unexpected error occurred: ${err.message || 'Unknown error'}\n\nPlease try again.`,
            contextInfo: channelInfo
        }, { quoted: message });
    }
}

module.exports = { animeDownloadCommand };
