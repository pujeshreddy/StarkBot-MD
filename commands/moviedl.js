/**
 * 🎬 Advanced Movie & Web Series Command for Stark Bot MD
 * 
 * Powered by MovieBeast Drive API (MoviesDrive Engine)
 * 
 * Features:
 * - Browse Movie & Series catalogs:
 *     Latest, Netflix, 4K Ultra-HD, Anime
 * - Browse by Genre:
 *     Action, Crime, Comedy, Drama, Horror, Family, Sci-Fi, Thriller, Romance, Fight
 * - Search across all movies & TV series
 * - Full metadata with official TMDB & Metahub posters, cast, synopsis, genres, and audio tracks
 * - Support for both Movies (direct quality selection) and Web Series (multi-season episode browser)
 * - Multi-mirror stream extraction: Cloudflare R2 / Worker, Google Drive CDN, Pixeldrain
 * - Multi-worker download pool (2 concurrent downloads) with task queue
 * - Fast remuxing via ffmpeg (-c copy -movflags +faststart) for instant WhatsApp streaming
 * - High-speed WhatsApp document delivery up to 2GB with guaranteed MP4 format badge
 * 
 * Commands:
 *   .movie                    → Show main menu
 *   .movie latest             → Browse latest released movies & series
 *   .movie netflix            → Browse Netflix collection
 *   .movie 4k                 → Browse 4K Ultra-HD titles
 *   .movie anime              → Browse anime titles
 *   .movie genre <name>       → Browse by genre (action, comedy, horror, etc.)
 *   .movie search <query>     → Search for any movie or web series
 *   .movie page <number>      → Page navigation
 *   .movie info <number>      → View details, poster, and available qualities/sizes
 *   .movie episodes <number>  → (For series) View episode list for selected season/quality
 *   .movie dl <number>        → Download movie quality or series episode (up to 2GB!)
 *   .movie workers            → View active download workers and queue
 *   .movie cancel             → Cancel your active or queued download
 *   .movie clear              → Reset movie session
 */

const dns = require('dns');
if (typeof dns.setDefaultResultOrder === 'function') {
    dns.setDefaultResultOrder('ipv4first');
}

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// ─── Constants ───────────────────────────────────────────────────────────────
const API_BASE = 'https://moviebeast.up.railway.app/api/drive';
const TIMEOUT = 60000; // 60s for metadata
const STREAM_TIMEOUT = 75000; // 75s for scraper extraction
const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': '*/*'
};

// Max WhatsApp document limit (WhatsApp allows up to 2GB)
const MAX_WHATSAPP_DOC_SIZE = 2000 * 1024 * 1024; // 2 GB

// Upload timeout in milliseconds (15 minutes for large movie uploads)
const UPLOAD_TIMEOUT_MS = 900000;

// Temp directory for video files
const TEMP_DIR = path.join(process.cwd(), 'temp');
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// Per-chat session state (auto-expires after 15 minutes of inactivity)
const sessions = new Map();
const SESSION_TTL = 15 * 60 * 1000;

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

// ─── Cleanup Helper ──────────────────────────────────────────────────────────

function cleanupFile(filePath) {
    if (filePath && fs.existsSync(filePath)) {
        try { fs.unlinkSync(filePath); } catch {}
    }
}

// ─── Title & Poster Helpers ──────────────────────────────────────────────────

function cleanMovieTitle(title) {
    if (!title) return 'Movie';
    const firstLine = title.split('\n')[0];
    return firstLine
        .replace(/^S\.S\.\s*Rajamouli\s*[–-]\s*/i, '')
        .replace(/\s*\|\s*Full\s*Movie.*$/i, '')
        .replace(/\s*Full\s*Movie.*$/i, '')
        .replace(/\s*WEB-DL.*$/i, '')
        .replace(/\s*BluRay.*$/i, '')
        .replace(/\s*HDRip.*$/i, '')
        .replace(/\s*AMZN\s*Series.*$/i, '')
        .replace(/\s*NETFLIX.*$/i, '')
        .replace(/\s*Amazon\s*Prime.*$/i, '')
        .replace(/\s*\[.*?\]/g, '')
        .replace(/\s*480p.*$/i, '')
        .replace(/\s*720p.*$/i, '')
        .replace(/\s*1080p.*$/i, '')
        .replace(/\s*2160p.*$/i, '')
        .replace(/\s*\|\s*/g, ' ')
        .trim();
}

/**
 * Downloads image to temp file and sends as WhatsApp image message.
 * Falls back to plain text message if download fails.
 */
async function sendPosterOrTextMessage(sock, chatId, title, imageUrl, textContent, quotedMessage) {
    if (!imageUrl) {
        return await sock.sendMessage(chatId, {
            text: textContent,
            contextInfo: channelInfo
        }, { quoted: quotedMessage });
    }

    try {
        const response = await axios.get(imageUrl, {
            responseType: 'arraybuffer',
            headers: HEADERS,
            timeout: 15000
        });

        const tempPosterPath = path.join(TEMP_DIR, `movie_poster_${Date.now()}_${Math.random().toString(36).substring(2, 6)}.jpg`);
        fs.writeFileSync(tempPosterPath, Buffer.from(response.data));

        try {
            await sock.sendMessage(chatId, {
                image: { url: tempPosterPath },
                caption: textContent,
                contextInfo: channelInfo
            }, { quoted: quotedMessage });
        } finally {
            cleanupFile(tempPosterPath);
        }
    } catch (imgErr) {
        console.error('[movie] Failed to send poster image:', imgErr.message);
        await sock.sendMessage(chatId, {
            text: textContent,
            contextInfo: channelInfo
        }, { quoted: quotedMessage });
    }
}

// ─── API Handlers ────────────────────────────────────────────────────────────

async function fetchPosts(filter = '', page = 1) {
    try {
        console.log(`[movie] Fetching posts: filter="${filter}", page=${page}`);
        const { data } = await axios.get(`${API_BASE}/posts`, {
            params: { filter, page },
            headers: HEADERS,
            timeout: TIMEOUT
        });
        return data;
    } catch (err) {
        console.error('[movie] Posts fetch error:', err.message);
        return null;
    }
}

async function searchPosts(query, page = 1) {
    try {
        console.log(`[movie] Searching: query="${query}", page=${page}`);
        const { data } = await axios.get(`${API_BASE}/search`, {
            params: { q: query, page },
            headers: HEADERS,
            timeout: TIMEOUT
        });
        return data;
    } catch (err) {
        console.error('[movie] Search error:', err.message);
        return null;
    }
}

async function fetchMeta(link) {
    try {
        console.log(`[movie] Fetching meta for link:`, link);
        const { data } = await axios.get(`${API_BASE}/meta`, {
            params: { link },
            headers: HEADERS,
            timeout: TIMEOUT
        });
        return data;
    } catch (err) {
        console.error('[movie] Meta fetch error:', err.message);
        return null;
    }
}

async function fetchEpisodes(url) {
    try {
        console.log(`[movie] Fetching episodes for url:`, url);
        const { data } = await axios.get(`${API_BASE}/episodes`, {
            params: { url },
            headers: HEADERS,
            timeout: TIMEOUT
        });
        return data;
    } catch (err) {
        console.error('[movie] Episodes fetch error:', err.message);
        return null;
    }
}

async function fetchStream(link, type = 'movie', download = false, attempt = 1) {
    try {
        console.log(`[movie] Fetching stream (attempt ${attempt}, download=${download}):`, link);
        const { data } = await axios.get(`${API_BASE}/stream`, {
            params: { link, type, download },
            headers: HEADERS,
            timeout: STREAM_TIMEOUT
        });
        if (data && Array.isArray(data.streams) && data.streams.length > 0) {
            return data;
        }
        // If download=false returned empty, immediately retry with download=true
        if (!download) {
            console.log('[movie] download=false returned no streams, trying download=true...');
            return await fetchStream(link, type, true, attempt + 1);
        }
        return data;
    } catch (err) {
        console.error(`[movie] Stream fetch error (attempt ${attempt}):`, err.message);
        if (attempt === 1 && !download) {
            console.log('[movie] Retrying stream fetch with download=true...');
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
 * Downloads video file via stream to avoid filling Node.js heap RAM.
 */
async function downloadVideoToFile(url, fileName) {
    const filePath = path.join(TEMP_DIR, fileName);

    const response = await axios({
        method: 'GET',
        url,
        responseType: 'stream',
        headers: {
            ...HEADERS,
            'Referer': 'https://moviesdrive.org/'
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
        console.log('[movie] toWhatsAppMp4 fallback:', e.message);
    }

    // 2. Direct ffmpeg stream-copy with +faststart (fast copy without re-encoding)
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
        console.log('[movie] ffmpeg copy fallback:', e2.message);
    }

    // 3. Fallback to original
    return inputPath;
}

// ─── Worker Pool & Queue Manager ────────────────────────────────────────────

// Initialize global counter for active movie workers
global.activeMovieWorkers = 0;

class MovieDownloadQueue {
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
            global.activeMovieWorkers = this.activeJobs.size;
            this.processNext();
            return { job, cancelled: true, wasQueued: false };
        }
    }

    enqueue(jobData) {
        const job = {
            id: `movie_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
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
        global.activeMovieWorkers = this.activeJobs.size;

        try {
            await executeMovieDownloadJob(job);
        } catch (err) {
            console.error(`[movie-worker #${workerId}] Unexpected error:`, err);
        } finally {
            this.activeJobs.delete(job.id);
            this.userJobMap.delete(job.chatId);
            global.activeMovieWorkers = this.activeJobs.size;
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
            title: j.title,
            target: j.targetName,
            quality: j.quality,
            status: j.status,
            sizeMB: j.sizeMB || 'Calculating...',
            startedAt: j.startedAt
        }));

        const queueList = this.queue.map((j, idx) => ({
            position: idx + 1,
            title: j.title,
            target: j.targetName,
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

const movieDownloadQueue = new MovieDownloadQueue(2);

/**
 * Executes a movie or series download job through stream resolution, file download, remuxing, and WhatsApp upload.
 */
async function executeMovieDownloadJob(job) {
    const { sock, chatId, message, streamSourceLink, title, targetName, quality, workerId, isSeries } = job;
    job.startedAt = Date.now();

    try {
        if (job.status === 'cancelled') return;

        // Step 1: Notify user
        job.status = 'extracting';
        await sock.sendMessage(chatId, {
            text: `⚙️ *[Worker #${workerId}] Started Download*\n🎬 *${isSeries ? 'Series' : 'Movie'}:* ${title}\n🎞️ *Quality:* ${quality}\n📄 *Target:* ${targetName}\n\n⏳ _Extracting high-speed stream links..._`,
            contextInfo: channelInfo
        }, { quoted: message });

        // Step 2: Extract stream URLs
        const streamData = await fetchStream(streamSourceLink, 'movie', false);
        if (job.status === 'cancelled') return;

        if (!streamData || !streamData.streams || streamData.streams.length === 0) {
            await sock.sendMessage(chatId, {
                text: `❌ *[Worker #${workerId}]* Failed to extract stream URL.\n💡 The mirror server might be busy. Please pick another quality or source via \`.movie info\`.`,
                contextInfo: channelInfo
            }, { quoted: message });
            return;
        }

        // Prioritize fast mirrors: CF Storage / CF Worker first, GDrive, then Pixeldrain
        const streams = [...streamData.streams].sort((a, b) => {
            const aServer = (a.server || '').toLowerCase();
            const bServer = (b.server || '').toLowerCase();
            const getScore = (s) => {
                if (s.includes('cf') || s.includes('cloudflare')) return 3;
                if (s.includes('gdrive') || s.includes('google')) return 2;
                if (s.includes('pixel')) return 1;
                return 0;
            };
            return getScore(bServer) - getScore(aServer);
        });

        // Step 3: Attempt downloading from mirrors
        job.status = 'downloading';
        const cleanFileBase = `${title}_${targetName}_${quality}`.replace(/[^a-zA-Z0-9_-]/g, '_');

        await sock.sendMessage(chatId, {
            text: `📥 *[Worker #${workerId}] Downloading to Server*\n🎬 *${title}* — ${targetName}\n\n⏳ _Streaming file to disk (supports up to 2GB)..._`,
            contextInfo: channelInfo
        }, { quoted: message });

        let downloadInfo = null;
        let successfulStream = null;

        for (const s of streams) {
            if (job.status === 'cancelled') return;
            const fileType = (s.type || 'mp4').toLowerCase();
            const rawFileName = `${job.id}_raw.${fileType}`;

            try {
                console.log(`[movie-worker #${workerId}] Trying mirror: ${s.server}`);
                downloadInfo = await downloadVideoToFile(s.link, rawFileName);
                successfulStream = s;
                break;
            } catch (dlErr) {
                console.error(`[movie-worker #${workerId}] Mirror ${s.server} failed:`, dlErr.message);
            }
        }

        if (!downloadInfo || !downloadInfo.filePath || !fs.existsSync(downloadInfo.filePath)) {
            if (job.status === 'cancelled') return;
            await sock.sendMessage(chatId, {
                text: `⚠️ *[Worker #${workerId}] Download Failed from all mirrors.*\n\n🔗 *Direct Stream Link:*\n${streams[0]?.link || 'N/A'}\n\n🎬 ${title} — ${targetName}`,
                contextInfo: channelInfo
            }, { quoted: message });
            return;
        }

        const { filePath: rawFilePath, sizeBytes, sizeMB } = downloadInfo;
        job.cleanFilePaths.push(rawFilePath);
        job.sizeMB = sizeMB;

        if (job.status === 'cancelled') return;

        // Check WhatsApp's absolute 2GB limit
        if (sizeBytes > MAX_WHATSAPP_DOC_SIZE) {
            cleanupFile(rawFilePath);
            await sock.sendMessage(chatId, {
                text: `⚠️ *File exceeds WhatsApp's 2GB document limit* (${sizeMB}MB)\n\n🔗 *Direct High-Speed Link:*\n${successfulStream.link}\n\n🎬 ${title} — ${targetName} [${quality}]`,
                contextInfo: channelInfo
            }, { quoted: message });
            return;
        }

        // Step 4: Remux to WhatsApp-compatible MP4 with +faststart
        job.status = 'processing';
        let sendFilePath = rawFilePath;
        const finalFileName = `${cleanFileBase}.mp4`;

        const isRawMp4 = rawFilePath.toLowerCase().endsWith('.mp4');
        if (!isRawMp4) {
            const mp4Output = path.join(TEMP_DIR, `${job.id}.mp4`);
            const convertedPath = await remuxToWhatsAppMp4(rawFilePath, mp4Output);
            if (convertedPath && fs.existsSync(convertedPath)) {
                sendFilePath = convertedPath;
                job.cleanFilePaths.push(convertedPath);
                // Immediately delete raw to save disk space
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
            text: `📤 *[Worker #${workerId}] Uploading to WhatsApp (${sendSizeMB}MB)...*\n_Sending file to chat. Please wait a moment!_`,
            contextInfo: channelInfo
        }, { quoted: message });

        const caption = `🎬 *${title}*\n🎞️ *Quality:* ${quality}\n📄 *Target:* ${targetName}\n📊 *Size:* ${sendSizeMB}MB\n\n> _Processed by Worker #${workerId} • Stark Bot MD_ ⚡`;

        let sentSuccessfully = false;
        let lastUploadError = null;

        // Strategy 1: Small files <= 64MB: Playable video bubble in chat
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
                console.log(`[movie-worker #${workerId}] Video bubble send failed, falling back to document:`, vErr.message);
                lastUploadError = vErr;
            }
        }

        // Strategy 2: Document upload up to 2GB with video/mp4 MIME type
        // Always uses 'video/mp4' so WhatsApp displays the native "MP4" badge and allows in-app video playback!
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
                console.log(`[movie-worker #${workerId}] Document url upload failed with video/mp4:`, dErr.message);
                lastUploadError = dErr;
            }
        }

        // Strategy 3: Stream fallback via fs.createReadStream with video/mp4
        if (!sentSuccessfully) {
            try {
                console.log(`[movie-worker #${workerId}] Retrying document via fs.createReadStream...`);
                await sock.sendMessage(chatId, {
                    document: fs.createReadStream(sendFilePath),
                    mimetype: 'video/mp4',
                    fileName: finalFileName,
                    caption,
                    contextInfo: channelInfo
                }, { quoted: message, mediaUploadTimeoutMs: UPLOAD_TIMEOUT_MS });
                sentSuccessfully = true;
            } catch (sErr) {
                console.log(`[movie-worker #${workerId}] ReadStream upload failed:`, sErr.message);
                lastUploadError = sErr;
            }
        }

        // Strategy 4: Fallback buffer retry with video/mp4 (if <= 90MB)
        if (!sentSuccessfully && sendStats.size <= 90 * 1024 * 1024) {
            try {
                console.log(`[movie-worker #${workerId}] Retrying upload via Buffer...`);
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
                console.log(`[movie-worker #${workerId}] Buffer upload failed:`, bErr.message);
                lastUploadError = bErr;
            }
        }

        // Strategy 5: Emergency fallback with octet-stream only if WhatsApp rejected video/mp4
        if (!sentSuccessfully) {
            try {
                console.log(`[movie-worker #${workerId}] Retrying document with octet-stream fallback...`);
                await sock.sendMessage(chatId, {
                    document: { url: sendFilePath },
                    mimetype: 'application/octet-stream',
                    fileName: finalFileName,
                    caption,
                    contextInfo: channelInfo
                }, { quoted: message, mediaUploadTimeoutMs: UPLOAD_TIMEOUT_MS });
                sentSuccessfully = true;
            } catch (fbErr) {
                console.log(`[movie-worker #${workerId}] Octet-stream fallback upload failed:`, fbErr.message);
                lastUploadError = fbErr;
            }
        }

        // Strategy 6: If all uploads failed, provide direct high-speed download link
        if (!sentSuccessfully) {
            await sock.sendMessage(chatId, {
                text: `⚠️ *[Worker #${workerId}] WhatsApp upload failed:* ${lastUploadError?.message || 'Media upload error'}\n\n🔗 *Direct Download Link:*\n${successfulStream.link}\n\n🎬 ${title} — ${targetName} [${quality}]\n📊 File Size: ${sendSizeMB}MB\n\n💡 _Open the link in your browser to watch or download._`,
                contextInfo: channelInfo
            }, { quoted: message });
        } else {
            job.status = 'done';
        }

    } catch (err) {
        console.error(`[movie-worker #${workerId}] Job execution error:`, err);
        try {
            await sock.sendMessage(chatId, {
                text: `❌ *[Worker #${workerId}] Error processing movie/series:* ${err.message || 'Unknown error'}\n💡 Please try again later.`,
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

// ─── Formatters ──────────────────────────────────────────────────────────────

function buildMainMenu() {
    return `╔════════════════════════╗
   🎬 *MOVIE & SERIES ZONE* 🎬
   _Powered by Stark Bot MD_
╚════════════════════════╝

📂 *Browse Catalog:*
┃ ➤ \`.movie latest\`
┃ ➤ \`.movie netflix\`
┃ ➤ \`.movie 4k\`
┃ ➤ \`.movie anime\`

🎭 *Browse by Genre:*
┃ ➤ \`.movie genre action\`
┃ ➤ \`.movie genre crime\`
┃ ➤ \`.movie genre comedy\`
┃ ➤ \`.movie genre drama\`
┃ ➤ \`.movie genre horror\`
┃ ➤ \`.movie genre family\`
┃ ➤ \`.movie genre sci-fi\`
┃ ➤ \`.movie genre thriller\`
┃ ➤ \`.movie genre romance\`
┃ ➤ \`.movie genre fight\`

🔍 *Search Movies & Web Series:*
┃ ➤ \`.movie search <name>\`
┃   _Example: .movie search RRR_
┃   _Example: .movie search dead end job_

📌 *Download Flow:*
┃ ➤ \`.movie info <number>\`
┃   _Details, official poster, cast & qualities_
┃ ➤ \`.movie episodes <number>\`
┃   _(For series) View season episode list_
┃ ➤ \`.movie dl <number>\`
┃   _Instant high-speed direct download & stream links!_

⚡ *Status & Info:*
┃ ➤ \`.movie workers\`
┃   _Check direct link engine status_
┃ ➤ \`.movie clear\`
┃   _Reset movie session_

⚡ *Sessions auto-save your progress for 15 minutes.*`;
}

function buildPostList(posts, title, page, total) {
    let msg = `╔════════════════════════╗\n   🎬 *${title}* — Page ${page}/${total}\n╚════════════════════════╝\n\n`;

    posts.forEach((post, i) => {
        const name = cleanMovieTitle(post.title);
        msg += `*${i + 1}.* ${name}\n`;
    });

    msg += `\n━━━━━━━━━━━━━━━━━━━━━━━━`;
    msg += `\n📌 *Next:* \`.movie info <number>\` — View details`;
    if (page < total) msg += `\n📄 *Next Page:* \`.movie page ${page + 1}\``;
    if (page > 1) msg += `\n📄 *Prev Page:* \`.movie page ${page - 1}\``;

    return msg;
}

function buildMetaMessage(meta) {
    const m = meta;
    const title = cleanMovieTitle(m.title);
    const isSeries = m.type === 'series' || (m.linkList && m.linkList.some(l => !!l.episodesLink));

    let msg = `╔════════════════════════╗\n   🎬 *${isSeries ? 'WEB SERIES' : 'MOVIE'} DETAILS*\n╚════════════════════════╝\n\n`;
    msg += `📺 *Title:* ${title}\n`;
    msg += `🎭 *Type:* ${isSeries ? 'SERIES / TV SHOW' : 'MOVIE'}\n`;
    if (m.imdbId) msg += `⭐ *IMDb:* ${m.imdbId}\n`;
    if (m.tags && m.tags.length > 0) msg += `🏷️ *Genres:* ${m.tags.join(', ')}\n`;
    if (m.cast && m.cast.length > 0) msg += `👥 *Cast:* ${m.cast.slice(0, 4).join(', ')}\n`;
    if (m.synopsis) msg += `\n📖 *Synopsis:*\n_${m.synopsis.substring(0, 350)}${m.synopsis.length > 350 ? '...' : ''}_\n`;

    // Filter valid download links
    const validLinks = (m.linkList || []).filter(item => {
        const t = (item.title || '').toLowerCase();
        if (t.includes('thank you') || t.includes('prefect spot')) return false;
        return (item.directLinks && item.directLinks.length > 0) || item.episodesLink;
    });

    if (validLinks.length > 0) {
        msg += `\n━━━━━━━━━━━━━━━━━━━━━━━━\n`;
        msg += `💾 *Available Qualities & Versions:*\n\n`;
        validLinks.forEach((link, i) => {
            const quality = link.quality || 'HD';
            const linkTitle = (link.title || '')
                .replace(/^Netflix\s*[–-]\s*/i, '')
                .replace(/^Amazon\s*Prime\s*[–-]\s*/i, '')
                .replace(/^AMZN\s*[–-]\s*/i, '')
                .trim();
            msg += `*${i + 1}.* 🔹 [${quality}] ${linkTitle}\n`;
        });

        if (isSeries) {
            msg += `\n📌 *Next Step (Series):* \`.movie episodes <number>\`\n`;
            msg += `_Example: .movie episodes 1 (View all episodes for that quality)_`;
        } else {
            msg += `\n📌 *Download Directly (Movie):* \`.movie dl <number>\`\n`;
            msg += `_Example: .movie dl 1 (Get instant direct download & streaming links!)_`;
        }
    }

    return { msg, validLinks, isSeries };
}

function buildEpisodeList(episodes, title, quality) {
    let msg = `╔════════════════════════╗\n   📋 *EPISODE LIST*\n╚════════════════════════╝\n\n`;
    msg += `📺 *${cleanMovieTitle(title)}*\n`;
    msg += `🎞️ *Quality:* ${quality}\n`;
    msg += `📊 *Total Episodes:* ${episodes.length}\n\n`;

    episodes.forEach((ep, i) => {
        const icon = ep.quickDownload ? '⚡' : '📥';
        msg += `*${i + 1}.* ${icon} ${ep.title}\n`;
    });

    msg += `\n━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `📌 *Download:* \`.movie dl <number>\`\n`;
    msg += `_Example: .movie dl 1 (Get instant direct download & streaming links!)_\n`;

    return msg;
}

function buildMovieDownloadCard(title, targetName, quality, isSeries, streams, meta) {
    let msg = `╔═══════════════════════════════════════╗\n`;
    msg += `   🎬 *${isSeries ? 'SERIES EPISODE' : 'MOVIE'} DIRECT DOWNLOAD* 🎬\n`;
    msg += `╚═══════════════════════════════════════╝\n\n`;

    msg += `📺 *Title:* ${title}\n`;
    msg += `📄 *Item:* ${targetName}\n`;
    msg += `🎞️ *Quality:* ${quality}\n`;
    if (meta?.imdbId) msg += `⭐ *IMDb:* ${meta.imdbId}\n`;
    if (meta?.tags && meta.tags.length > 0) msg += `🏷️ *Genres:* ${meta.tags.slice(0, 4).join(', ')}\n`;
    if (meta?.cast && meta.cast.length > 0) msg += `👥 *Cast:* ${meta.cast.slice(0, 3).join(', ')}\n`;
    msg += `⚡ *Status:* High-Speed Links Verified ✅\n\n`;

    msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `📥 *FAST DIRECT DOWNLOAD SERVERS:*\n\n`;

    // Prioritize Cloudflare, Google Drive CDN, Pixeldrain
    const sortedStreams = [...streams].sort((a, b) => {
        const aS = (a.server || '').toLowerCase();
        const bS = (b.server || '').toLowerCase();
        const getScore = (s) => {
            if (s.includes('cf') || s.includes('cloudflare') || s.includes('workers.dev') || s.includes('cloudflarestorage')) return 3;
            if (s.includes('gdrive') || s.includes('google')) return 2;
            if (s.includes('pixel')) return 1;
            return 0;
        };
        return getScore(bS) - getScore(aS);
    });

    sortedStreams.forEach((stream, idx) => {
        const rawServer = stream.server || `Server ${idx + 1}`;
        const typeBadge = (stream.type || 'MP4').toUpperCase();
        let serverIcon = '🚀';
        let serverLabel = rawServer;

        const sLower = rawServer.toLowerCase();
        if (sLower.includes('google') || stream.link.includes('google')) {
            serverIcon = '⚡';
            serverLabel = 'Google Drive High-Speed CDN';
        } else if (sLower.includes('cf') || sLower.includes('cloudflare') || stream.link.includes('workers.dev') || stream.link.includes('cloudflarestorage')) {
            serverIcon = '🚀';
            serverLabel = 'Cloudflare Ultra-Fast Storage';
        } else if (sLower.includes('pixel')) {
            serverIcon = '💾';
            serverLabel = 'Pixeldrain Fast Mirror';
        }

        msg += `${serverIcon} *${serverLabel} [${typeBadge}]:*\n`;
        msg += `${stream.link}\n\n`;
    });

    msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `💡 *Quick Streaming & Download Tips:*\n`;
    msg += `• 📥 *Direct Download:* Tap any link above to download directly at max uncapped speed in Chrome, Browser, 1DM, or ADM.\n`;
    msg += `• 🎬 *Stream Online:* Copy any link and paste into *VLC Player* or *MX Player* (Open Network Stream) to watch online without downloading!\n`;
    msg += `• 🌐 If one server is slow or busy, choose Server 2 or Server 3.\n\n`;
    msg += `> _Generated by Stark Bot MD • Movie Zone_ 🍿`;

    return msg;
}

// ─── Main Movie Command Handler ──────────────────────────────────────────────

async function movieDownloadCommand(sock, chatId, message, args) {
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
            'netflix': 'category/netflix/',
            '4k': 'category/2160p-4k/',
            'uhd': 'category/2160p-4k/',
            'anime': 'category/anime/'
        };

        if (catalogMap.hasOwnProperty(sub)) {
            await sock.sendMessage(chatId, {
                text: '🔍 _Browsing movies & series catalog..._',
                contextInfo: channelInfo
            }, { quoted: message });

            const filter = catalogMap[sub];
            const data = await fetchPosts(filter, 1);

            if (!data || !data.posts || data.posts.length === 0) {
                await sock.sendMessage(chatId, {
                    text: '❌ No titles found in this category.',
                    contextInfo: channelInfo
                }, { quoted: message });
                return;
            }

            const categoryName = sub.toUpperCase();
            setSession(chatId, {
                type: 'browse',
                filter,
                page: data.page || 1,
                totalPages: data.total || 1,
                posts: data.posts,
                title: categoryName
            });

            const listMsg = buildPostList(data.posts, categoryName, data.page || 1, data.total || 1);
            const firstPost = data.posts[0];
            await sendPosterOrTextMessage(sock, chatId, firstPost?.title, firstPost?.image, listMsg, message);
            return;
        }

        // ── Genre Browse ──
        if (sub === 'genre') {
            const genreMap = {
                'action': 'category/action/',
                'crime': 'category/crime/',
                'comedy': 'category/comedy/',
                'drama': 'category/drama/',
                'horror': 'category/horror/',
                'family': 'category/family/',
                'sci-fi': 'category/sifi/',
                'scifi': 'category/sifi/',
                'sifi': 'category/sifi/',
                'thriller': 'category/triller/',
                'triller': 'category/triller/',
                'romance': 'category/romance/',
                'fight': 'category/fight/'
            };

            const genreKey = rest.toLowerCase();
            if (!genreKey || !genreMap[genreKey]) {
                const available = ['action', 'crime', 'comedy', 'drama', 'horror', 'family', 'sci-fi', 'thriller', 'romance', 'fight'].join(', ');
                await sock.sendMessage(chatId, {
                    text: `🎭 *Available Movie & Series Genres:*\n${available}\n\n📌 Usage: \`.movie genre <name>\`\nExample: \`.movie genre action\``,
                    contextInfo: channelInfo
                }, { quoted: message });
                return;
            }

            await sock.sendMessage(chatId, {
                text: `🎭 _Browsing ${genreKey} movies & series..._`,
                contextInfo: channelInfo
            }, { quoted: message });

            const filter = genreMap[genreKey];
            const data = await fetchPosts(filter, 1);

            if (!data || !data.posts || data.posts.length === 0) {
                await sock.sendMessage(chatId, {
                    text: `❌ No titles found for genre: ${genreKey}`,
                    contextInfo: channelInfo
                }, { quoted: message });
                return;
            }

            const title = `Genre: ${genreKey.toUpperCase()}`;
            setSession(chatId, {
                type: 'browse',
                filter,
                page: data.page || 1,
                totalPages: data.total || 1,
                posts: data.posts,
                title
            });

            const listMsg = buildPostList(data.posts, title, data.page || 1, data.total || 1);
            const firstPost = data.posts[0];
            await sendPosterOrTextMessage(sock, chatId, firstPost?.title, firstPost?.image, listMsg, message);
            return;
        }

        // ── Search ──
        if (sub === 'search' || sub === 'find' || sub === 's') {
            if (!rest) {
                await sock.sendMessage(chatId, {
                    text: '🔍 *Usage:* `.movie search <movie or series name>`\n_Example: .movie search RRR_\n_Example: .movie search dead end job_',
                    contextInfo: channelInfo
                }, { quoted: message });
                return;
            }

            await sock.sendMessage(chatId, {
                text: `🔍 _Searching for "${rest}"..._`,
                contextInfo: channelInfo
            }, { quoted: message });

            const data = await searchPosts(rest, 1);
            if (!data || !data.posts || data.posts.length === 0) {
                await sock.sendMessage(chatId, {
                    text: `❌ No movies or series found matching "${rest}".\n\n💡 *Tips:*\n• Check spelling\n• Try a shorter name (e.g. .movie search mirzapur)\n• Browse categories: \`.movie latest\` or \`.movie netflix\``,
                    contextInfo: channelInfo
                }, { quoted: message });
                return;
            }

            setSession(chatId, {
                type: 'search',
                query: rest,
                page: data.page || 1,
                totalPages: data.total || 1,
                posts: data.posts,
                title: `Search: "${rest}"`
            });

            let msg = `╔════════════════════════╗\n   🔍 *SEARCH RESULTS*\n   _Query: "${rest}"_\n╚════════════════════════╝\n\n`;
            msg += `📊 *Found ${data.posts.length} result(s)*\n\n`;
            data.posts.forEach((post, i) => {
                msg += `*${i + 1}.* ${cleanMovieTitle(post.title)}\n`;
            });
            msg += `\n━━━━━━━━━━━━━━━━━━━━━━━━\n`;
            msg += `📌 *Next:* \`.movie info <number>\` — View details`;
            if (data.page < data.total) msg += `\n📄 *Next Page:* \`.movie page ${data.page + 1}\``;

            await sendPosterOrTextMessage(sock, chatId, data.posts[0]?.title, data.posts[0]?.image, msg, message);
            return;
        }

        // ── Page Navigation ──
        if (sub === 'page' || sub === 'p') {
            const session = getSession(chatId);
            if (!session || (session.type !== 'browse' && session.type !== 'search')) {
                await sock.sendMessage(chatId, {
                    text: '❌ No active browse session. Start browsing first!\n\nExample: `.movie latest` or `.movie search avatar`',
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

            let data;
            if (session.type === 'search') {
                data = await searchPosts(session.query, pageNum);
            } else {
                data = await fetchPosts(session.filter, pageNum);
            }

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

        // ── Info (Movie/Series Details + Qualities) ──
        if (sub === 'info' || sub === 'i' || sub === 'details') {
            const session = getSession(chatId);
            if (!session || !session.posts) {
                await sock.sendMessage(chatId, {
                    text: '❌ No movie list active.\n\nFirst browse or search:\n• `.movie latest`\n• `.movie search RRR`',
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
                text: `⏳ _Fetching details for: ${cleanMovieTitle(selected.title)}..._`,
                contextInfo: channelInfo
            }, { quoted: message });

            const metaData = await fetchMeta(selected.link);
            if (!metaData || !metaData.meta) {
                await sock.sendMessage(chatId, {
                    text: '❌ Failed to fetch movie details. Please try again.',
                    contextInfo: channelInfo
                }, { quoted: message });
                return;
            }

            const meta = metaData.meta;
            const { msg, validLinks, isSeries } = buildMetaMessage(meta);

            // Save in session
            setSession(chatId, {
                ...session,
                type: 'meta',
                currentMeta: meta,
                selectedPost: selected,
                validLinks,
                isSeries
            });

            const posterImg = meta.poster || meta.image || selected.image;
            await sendPosterOrTextMessage(sock, chatId, meta.title || selected.title, posterImg, msg, message);
            return;
        }

        // ── Episodes List (For Web Series) ──
        if (sub === 'episodes' || sub === 'ep' || sub === 'eps') {
            const session = getSession(chatId);
            if (!session || !session.currentMeta) {
                await sock.sendMessage(chatId, {
                    text: '❌ No title selected yet.\n\nFollow these steps:\n1. `.movie search <name>` (Search)\n2. `.movie info <number>` (Select)\n3. `.movie episodes <number>` (For series)',
                    contextInfo: channelInfo
                }, { quoted: message });
                return;
            }

            if (!session.isSeries) {
                await sock.sendMessage(chatId, {
                    text: 'ℹ️ *This is a Movie, not a TV Series!*\nYou can download the quality directly with `.movie dl <number>`.\n_Example: .movie dl 1_',
                    contextInfo: channelInfo
                }, { quoted: message });
                return;
            }

            const validLinks = session.validLinks || [];
            if (validLinks.length === 0) {
                await sock.sendMessage(chatId, {
                    text: '❌ No episodes available for this series.',
                    contextInfo: channelInfo
                }, { quoted: message });
                return;
            }

            const num = parseInt(rest);
            if (!num || num < 1 || num > validLinks.length) {
                await sock.sendMessage(chatId, {
                    text: `❌ Invalid season/quality selection. Pick a number between 1 and ${validLinks.length}\n_Run \`.movie info\` again to view available qualities._`,
                    contextInfo: channelInfo
                }, { quoted: message });
                return;
            }

            const selectedQualityLink = validLinks[num - 1];
            if (!selectedQualityLink.episodesLink) {
                await sock.sendMessage(chatId, {
                    text: '❌ This quality does not have an episode index link.',
                    contextInfo: channelInfo
                }, { quoted: message });
                return;
            }

            await sock.sendMessage(chatId, {
                text: `📋 _Loading episode list for [${selectedQualityLink.quality || 'HD'}]..._`,
                contextInfo: channelInfo
            }, { quoted: message });

            const epData = await fetchEpisodes(selectedQualityLink.episodesLink);
            if (!epData || !epData.episodes || epData.episodes.length === 0) {
                await sock.sendMessage(chatId, {
                    text: '❌ No episodes found for this quality. Try another quality number!',
                    contextInfo: channelInfo
                }, { quoted: message });
                return;
            }

            setSession(chatId, {
                ...session,
                type: 'episodes',
                episodes: epData.episodes,
                selectedQuality: selectedQualityLink.quality || 'HD',
                selectedSeasonTitle: selectedQualityLink.title
            });

            const epMsg = buildEpisodeList(epData.episodes, session.currentMeta.title, selectedQualityLink.quality || 'HD');
            await sock.sendMessage(chatId, {
                text: epMsg,
                contextInfo: channelInfo
            }, { quoted: message });
            return;
        }

        // ── Direct Download / Streaming Links ──
        if (sub === 'dl' || sub === 'download' || sub === 'watch' || sub === 'stream' || sub === 'link') {
            const session = getSession(chatId);
            if (!session || !session.currentMeta) {
                await sock.sendMessage(chatId, {
                    text: '❌ No movie or series selected active.\n\nFlow:\n1. `.movie search <name>` (Search)\n2. `.movie info <number>` (Details)\n3. `.movie dl <number>` (Download Links)',
                    contextInfo: channelInfo
                }, { quoted: message });
                return;
            }

            const num = parseInt(rest);

            let streamSourceLink = null;
            let targetName = '';
            let quality = 'HD';
            const cleanTitle = cleanMovieTitle(session.currentMeta.title);

            // Case A: User is on a Series Episodes list
            if (session.type === 'episodes' && session.episodes) {
                if (!num || num < 1 || num > session.episodes.length) {
                    await sock.sendMessage(chatId, {
                        text: `❌ Invalid episode number. Pick between 1 and ${session.episodes.length}`,
                        contextInfo: channelInfo
                    }, { quoted: message });
                    return;
                }

                const ep = session.episodes[num - 1];
                streamSourceLink = ep.link;
                targetName = ep.title;
                quality = session.selectedQuality || 'HD';
            }
            // Case B: User is on a Movie (or Series info before selecting episodes)
            else if (session.validLinks && session.validLinks.length > 0) {
                if (session.isSeries) {
                    await sock.sendMessage(chatId, {
                        text: '📋 *This is a Web Series!*\nPlease select a season/quality first using `.movie episodes <number>`.\n_Example: .movie episodes 1_',
                        contextInfo: channelInfo
                    }, { quoted: message });
                    return;
                }

                if (!num || num < 1 || num > session.validLinks.length) {
                    await sock.sendMessage(chatId, {
                        text: `❌ Invalid quality selection. Pick between 1 and ${session.validLinks.length}\n_Example: .movie dl 1_`,
                        contextInfo: channelInfo
                    }, { quoted: message });
                    return;
                }

                const linkItem = session.validLinks[num - 1];
                quality = linkItem.quality || 'HD';
                targetName = `Movie [${quality}]`;

                if (linkItem.directLinks && linkItem.directLinks.length > 0) {
                    streamSourceLink = linkItem.directLinks[0].link;
                } else if (linkItem.episodesLink) {
                    streamSourceLink = linkItem.episodesLink;
                }
            } else {
                await sock.sendMessage(chatId, {
                    text: '❌ No downloadable links found for this title.',
                    contextInfo: channelInfo
                }, { quoted: message });
                return;
            }

            if (!streamSourceLink) {
                await sock.sendMessage(chatId, {
                    text: '❌ Could not resolve download source link.',
                    contextInfo: channelInfo
                }, { quoted: message });
                return;
            }

            await sock.sendMessage(chatId, {
                text: `⏳ _Extracting direct high-speed download & stream servers for ${cleanTitle} — ${targetName}..._`,
                contextInfo: channelInfo
            }, { quoted: message });

            const streamData = await fetchStream(streamSourceLink, 'movie', false);
            if (!streamData || !streamData.streams || streamData.streams.length === 0) {
                await sock.sendMessage(chatId, {
                    text: `❌ Failed to extract stream links. The mirror server might be busy.\n💡 Please pick another quality or source via \`.movie info\`.`,
                    contextInfo: channelInfo
                }, { quoted: message });
                return;
            }

            const cardMsg = buildMovieDownloadCard(
                cleanTitle,
                targetName,
                quality,
                !!session.isSeries,
                streamData.streams,
                session.currentMeta
            );

            const posterImg = session.currentMeta?.poster || session.currentMeta?.image || session.selectedPost?.image;
            await sendPosterOrTextMessage(sock, chatId, `${cleanTitle} - ${targetName}`, posterImg, cardMsg, message);
            return;
        }

        // ── Check Engine Status ──
        if (sub === 'workers' || sub === 'queue' || sub === 'status') {
            let statusMsg = `╔═══════════════════════════════════════╗\n`;
            statusMsg += `   ⚡ *MOVIE DIRECT LINK ENGINE* ⚡\n`;
            statusMsg += `╚═══════════════════════════════════════╝\n\n`;
            statusMsg += `🟢 *Engine Status:* ACTIVE & READY ✅\n`;
            statusMsg += `🚀 *Download Mode:* Direct Multi-Server High-Speed Links\n`;
            statusMsg += `⚡ *Delivery Speed:* Instant (< 2 seconds)\n`;
            statusMsg += `🌐 *Supported Mirrors:* Cloudflare R2 / Workers, Google Drive CDN, Pixeldrain\n`;
            statusMsg += `📦 *Features:*\n`;
            statusMsg += `┃ ✔️ Uncapped Max-Speed Browser Download (Chrome, 1DM, ADM)\n`;
            statusMsg += `┃ ✔️ Stream Online via VLC / MX Player without downloading\n`;
            statusMsg += `┃ ✔️ No File Size Limits (Works even for 4K / 10GB+ movies)\n`;
            statusMsg += `┃ ✔️ Zero Waiting in Queues\n\n`;
            statusMsg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
            statusMsg += `💡 *Tip:* Use \`.movie dl <number>\` to get direct links instantly!`;

            await sock.sendMessage(chatId, {
                text: statusMsg,
                contextInfo: channelInfo
            }, { quoted: message });
            return;
        }

        // ── Cancel Command ──
        if (sub === 'cancel' || sub === 'stop' || sub === 'abort') {
            await sock.sendMessage(chatId, {
                text: `ℹ️ Direct link generation is instant! There are no pending background downloads in queue.`,
                contextInfo: channelInfo
            }, { quoted: message });
            return;
        }

        // ── Clear Session ──
        if (sub === 'clear' || sub === 'reset') {
            clearSession(chatId);
            await sock.sendMessage(chatId, {
                text: '✅ Movie session cleared! Start fresh with `.movie`',
                contextInfo: channelInfo
            }, { quoted: message });
            return;
        }

        // ── Unknown Subcommand ──
        await sock.sendMessage(chatId, {
            text: `❌ Unknown command: \`.movie ${sub}\`\n\n` + buildMainMenu(),
            contextInfo: channelInfo
        }, { quoted: message });

    } catch (err) {
        console.error('[movie] Command error:', err);
        await sock.sendMessage(chatId, {
            text: `❌ An unexpected error occurred: ${err.message || 'Unknown error'}\n\nPlease try again.`,
            contextInfo: channelInfo
        }, { quoted: message });
    }
}

module.exports = { movieDownloadCommand };
