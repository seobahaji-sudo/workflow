/**
 * GTA VI Pro Auto-Publisher for gtavistore.ir
 * با سیستم پیش‌نویس وردپرس، ترجمه پیشرفته با جمینای و تنظیمات سئو رنک‌مث
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { GoogleGenAI } = require('@google/genai');

require('dotenv').config();

const CONFIG_PATH = path.join(__dirname, 'config.json');
const HISTORY_PATH = path.join(__dirname, 'history.json');
const DRAFTS_DIR = path.join(__dirname, 'drafts');

if (!fs.existsSync(DRAFTS_DIR)) fs.mkdirSync(DRAFTS_DIR, { recursive: true });

const DEFAULT_GTA6_IMAGES = [
    'https://images.unsplash.com/photo-1542751371-adc38448a05e?auto=format&fit=crop&w=800&q=80',
    'https://images.unsplash.com/photo-1511512578047-dfb367046420?auto=format&fit=crop&w=800&q=80',
    'https://images.unsplash.com/photo-1538481199705-c710c4e965fc?auto=format&fit=crop&w=800&q=80'
];

function loadConfig() {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
}

function loadHistory() {
    if (fs.existsSync(HISTORY_PATH)) {
        try { return JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf-8')); } catch (e) { return []; }
    }
    return [];
}

function saveHistory(history) {
    fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2), 'utf-8');
}

function requestHttp(targetUrl, options = {}, postData = null) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(targetUrl);
        const client = urlObj.protocol === 'https:' ? https : http;

        const reqOptions = {
            protocol: urlObj.protocol,
            hostname: urlObj.hostname,
            port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
            path: urlObj.pathname + (urlObj.search || ''),
            method: options.method || (postData ? 'POST' : 'GET'),
            rejectUnauthorized: false,
            headers: { 'User-Agent': 'Mozilla/5.0', ...options.headers }
        };

        if (postData && !reqOptions.headers['Content-Length']) {
            reqOptions.headers['Content-Length'] = Buffer.isBuffer(postData) ? postData.length : Buffer.byteLength(postData);
        }

        const req = client.request(reqOptions, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                const nextUrl = new URL(res.headers.location, targetUrl).toString();
                return resolve(requestHttp(nextUrl, { ...options, method: 'GET' }));
            }
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: data }));
        });

        req.on('error', reject);
        req.setTimeout(25000, () => reject(new Error('Connection timed out')));
        if (postData) req.write(postData);
        req.end();
    });
}

function downloadBinary(targetUrl) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(targetUrl);
        const client = urlObj.protocol === 'https:' ? https : http;

        const req = client.get(targetUrl, { rejectUnauthorized: false }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return resolve(downloadBinary(new URL(res.headers.location, targetUrl).toString()));
            }
            if (res.statusCode !== 200) return reject(new Error(`Failed to download: ${res.statusCode}`));
            
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve({
                buffer: Buffer.concat(chunks),
                contentType: res.headers['content-type'] || 'image/jpeg'
            }));
        });
        req.on('error', reject);
    });
}

function parseRss(xmlText) {
    const items = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
    let match;
    while ((match = itemRegex.exec(xmlText)) !== null) {
        const itemContent = match[1];
        const titleMatch = /<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i.exec(itemContent);
        const linkMatch = /<link>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/i.exec(itemContent);
        const descMatch = /<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/i.exec(itemContent);
        
        const mediaMatch = /<media:content[^>]+url=["']([^"']+)["']|<enclosure[^>]+url=["']([^"']+)["']|<img[^>]+src=["']([^"']+)["']/i.exec(itemContent);
        const imageUrl = mediaMatch ? (mediaMatch[1] || mediaMatch[2] || mediaMatch[3]) : null;

        let title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : '';
        const link = linkMatch ? linkMatch[1].trim() : '';
        let description = descMatch ? descMatch[1].replace(/<[^>]+>/g, '').trim() : '';

        if (title && (title.toLowerCase().includes('gta') || title.toLowerCase().includes('grand theft auto'))) {
            items.push({ title, link, description, imageUrl });
        }
    }
    return items;
}

async function fetchAndCleanDuplicatePosts(wpUrl, username, password) {
    const apiUrl = `${wpUrl.replace(/\/+$/, '')}/wp-json/wp/v2/posts?per_page=50`;
    const authHeader = 'Basic ' + Buffer.from(`${username}:${password.replace(/\s+/g, '')}`).toString('base64');
    try {
        const res = await requestHttp(apiUrl, { method: 'GET', headers: { 'Authorization': authHeader } });
        if (res.statusCode !== 200) return [];
        return JSON.parse(res.body);
    } catch (e) {
        return [];
    }
}

async function uploadFeaturedImage(wpUrl, username, password, imageUrl) {
    try {
        const { buffer, contentType } = await downloadBinary(imageUrl);
        const filename = `gta6-cover-${Date.now()}.jpg`;
        const apiUrl = `${wpUrl.replace(/\/+$/, '')}/wp-json/wp/v2/media`;
        const authHeader = 'Basic ' + Buffer.from(`${username}:${password.replace(/\s+/g, '')}`).toString('base64');

        const res = await new Promise((resolve, reject) => {
            const urlObj = new URL(apiUrl);
            const client = urlObj.protocol === 'https:' ? https : http;
            const req = client.request({
                protocol: urlObj.protocol, hostname: urlObj.hostname, path: urlObj.pathname,
                method: 'POST',
                headers: {
                    'Authorization': authHeader,
                    'Content-Type': contentType,
                    'Content-Disposition': `attachment; filename="${filename}"`,
                    'Content-Length': buffer.length
                }
            }, (resp) => {
                let d = '';
                resp.on('data', chunk => d += chunk);
                resp.on('end', () => resolve({ statusCode: resp.statusCode, body: d }));
            });
            req.on('error', reject);
            req.write(buffer);
            req.end();
        });

        if (res.statusCode >= 200 && res.statusCode < 300) {
            const mediaJson = JSON.parse(res.body);
            return { mediaId: mediaJson.id, sourceUrl: mediaJson.source_url };
        }
    } catch (err) {}
    return null;
}

async function generateAIContent(newsItem, recentPosts) {
    const geminiApiKey = process.env.GEMINI_API_KEY;
    if (!geminiApiKey) {
        throw new Error("API Key is missing!");
    }

    const ai = new GoogleGenAI({ apiKey: geminiApiKey });

    let prevPostsText = "";
    if (recentPosts && recentPosts.length > 0) {
        prevPostsText = "پست‌های قبلی سایت ما برای لینک‌سازی داخلی:\n" + 
            recentPosts.slice(0,3).map(p => `- Title: ${p.title.rendered}, URL: ${p.link}`).join('\n');
    }

    const prompt = `شما یک کارشناس سئو و نویسنده ارشد وردپرس هستید.
خبر زیر را از انگلیسی دریافت کرده و یک مقاله خبری عالی به زبان فارسی روان، جذاب و سئو شده درباره بازی GTA 6 بنویسید.

خبر اصلی:
عنوان: ${newsItem.title}
متن کوتاه: ${newsItem.description}

دستورالعمل‌ها:
۱. عنوان پست جذاب و کلیک‌خور برای مخاطب ایرانی باشد.
۲. در متن مقاله از تگ‌های هدینگ <h2> و <h3> استفاده کنید.
۳. به صفحات داخلی فروشگاه (مثل https://gtavistore.ir/product/gta-vi/) لینک بدهید.
۴. ${prevPostsText} به این موارد هم لینک داخلی بدهید.
۵. خروجی را فقط به صورت یک آبجکت JSON معتبر برگردانید:
{
  "title": "عنوان جذاب",
  "content": "متن کامل مقاله به فرمت HTML",
  "rank_math_title": "عنوان سئو برای رنک مث",
  "rank_math_description": "توضیحات متا برای رنک مث (حدود 150 کاراکتر)",
  "rank_math_focus_keyword": "کلمه کلیدی کانونی"
}`;
    
    const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
        config: { responseMimeType: "application/json", temperature: 0.7 }
    });

    const jsonText = response.text;
    try {
        return JSON.parse(jsonText);
    } catch (e) {
        throw new Error("جمینای خروجی JSON معتبری برنگرداند.");
    }
}

async function publishPostAsDraft(wpUrl, username, password, aiData, featuredMediaId) {
    const apiUrl = `${wpUrl.replace(/\/+$/, '')}/wp-json/wp/v2/posts`;
    const authHeader = 'Basic ' + Buffer.from(`${username}:${password.replace(/\s+/g, '')}`).toString('base64');
    
    const payloadObj = {
        title: aiData.title,
        content: aiData.content,
        status: 'draft',
        meta: {
            rank_math_title: aiData.rank_math_title,
            rank_math_description: aiData.rank_math_description,
            rank_math_focus_keyword: aiData.rank_math_focus_keyword
        }
    };

    if (featuredMediaId) payloadObj.featured_media = featuredMediaId;

    const res = await requestHttp(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': authHeader }
    }, JSON.stringify(payloadObj));

    if (res.statusCode >= 200 && res.statusCode < 300) return JSON.parse(res.body);
    throw new Error(`WordPress REST API Error: ${res.statusCode} - ${res.body}`);
}

async function main() {
    const config = loadConfig();
    const history = loadHistory();
    const { wp_url, wp_username, wp_password } = config.site_settings;

    const existingPosts = await fetchAndCleanDuplicatePosts(wp_url, wp_username, wp_password);
    
    let foundNews = [];
    for (const feedUrl of config.rss_feeds) {
        try { foundNews.push(...parseRss((await requestHttp(feedUrl)).body)); } catch (err) {}
    }

    let candidateNews = foundNews.filter(item => !history.includes(item.link));

    if (candidateNews.length === 0) {
        console.log('هیچ خبر جدیدی یافت نشد!');
        return;
    }

    const targetNews = candidateNews[0];
    const finalImageUrl = targetNews.imageUrl || DEFAULT_GTA6_IMAGES[Math.floor(Math.random() * DEFAULT_GTA6_IMAGES.length)];

    const aiData = await generateAIContent(targetNews, existingPosts);

    let featuredMediaId = null;
    try {
        const mediaResult = await uploadFeaturedImage(wp_url, wp_username, wp_password, finalImageUrl);
        if (mediaResult) featuredMediaId = mediaResult.mediaId;
    } catch (e) {}

    if (featuredMediaId) {
        aiData.content = `<img src="${finalImageUrl}" alt="${aiData.title}" class="aligncenter size-large" />\n\n` + aiData.content;
    }

    try {
        await publishPostAsDraft(wpUrl, wp_username, wp_password, aiData, featuredMediaId);
        history.push(targetNews.link);
        saveHistory(history);
        console.log('🎉 SUCCESS! Post saved as DRAFT in gtavistore.ir');
    } catch (pubErr) {
        console.error(`Error: ${pubErr.message}`);
    }
}

main().catch(err => console.error('Fatal error:', err));
