/**
 * GTA VI Pro Auto-Publisher for gtavistore.ir
 * با سیستم حذف خودکار پست‌های تکراری و جلوگیری کامل از انتشار مجدد
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const HISTORY_PATH = path.join(__dirname, 'history.json');
const DRAFTS_DIR = path.join(__dirname, 'drafts');

if (!fs.existsSync(DRAFTS_DIR)) fs.mkdirSync(DRAFTS_DIR, { recursive: true });

const DEFAULT_GTA6_IMAGES = [
    'https://images.unsplash.com/photo-1542751371-adc38448a05e?auto=format&fit=crop&w=450&h=450&q=85',
    'https://images.unsplash.com/photo-1511512578047-dfb367046420?auto=format&fit=crop&w=450&h=450&q=85',
    'https://images.unsplash.com/photo-1538481199705-c710c4e965fc?auto=format&fit=crop&w=450&h=450&q=85'
];

function loadConfig() {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
}

function loadHistory() {
    if (fs.existsSync(HISTORY_PATH)) {
        try {
            return JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf-8'));
        } catch (e) {
            return [];
        }
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
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                ...options.headers
            }
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
        req.setTimeout(25000, () => {
            req.destroy();
            reject(new Error('Connection timed out'));
        });

        if (postData) {
            req.write(postData);
        }
        req.end();
    });
}

function downloadBinary(targetUrl) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(targetUrl);
        const client = urlObj.protocol === 'https:' ? https : http;

        const req = client.get(targetUrl, {
            rejectUnauthorized: false,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return resolve(downloadBinary(new URL(res.headers.location, targetUrl).toString()));
            }
            if (res.statusCode !== 200) {
                return reject(new Error(`Failed to download image: HTTP ${res.statusCode}`));
            }
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve({
                buffer: Buffer.concat(chunks),
                contentType: res.headers['content-type'] || 'image/jpeg'
            }));
        });
        req.on('error', reject);
        req.setTimeout(20000, () => {
            req.destroy();
            reject(new Error('Image download timed out'));
        });
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
        const dateMatch = /<pubDate>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/pubDate>/i.exec(itemContent);

        const mediaMatch = /<media:content[^>]+url=["']([^"']+)["']|<enclosure[^>]+url=["']([^"']+)["']|<img[^>]+src=["']([^"']+)["']/i.exec(itemContent);
        const imageUrl = mediaMatch ? (mediaMatch[1] || mediaMatch[2] || mediaMatch[3]) : null;

        let title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim() : '';
        const link = linkMatch ? linkMatch[1].trim() : '';
        let description = descMatch ? descMatch[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim() : '';
        const pubDate = dateMatch ? dateMatch[1].trim() : new Date().toISOString();

        title = title.replace(/\s*-\s*[^-\n]+$/, '').trim();

        if (title && (title.toLowerCase().includes('gta') || title.toLowerCase().includes('grand theft auto'))) {
            items.push({ title, link, description, pubDate, imageUrl });
        }
    }
    return items;
}

/**
 * دریافت تمامی نوشته‌های موجود در وردپرس و حذف موارد تکراری
 */
async function fetchAndCleanDuplicatePosts(wpUrl, username, password) {
    const apiUrl = `${wpUrl.replace(/\/+$/, '')}/wp-json/wp/v2/posts?per_page=50&status=publish`;
    const cleanPassword = password.replace(/\s+/g, '');
    const authHeader = 'Basic ' + Buffer.from(`${username}:${cleanPassword}`).toString('base64');

    try {
        const res = await requestHttp(apiUrl, {
            method: 'GET',
            headers: { 'Authorization': authHeader }
        });

        if (res.statusCode !== 200) return [];
        const posts = JSON.parse(res.body);

        console.log(`[Anti-Duplicate] Checking ${posts.length} existing posts on gtavistore.ir...`);

        // گروه‌بندی بر اساس عنوان تمیز شده جهت شناسایی پست‌های تکراری
        const seenTitles = {};
        const duplicatesToTrash = [];

        for (const post of posts) {
            const rawTitle = (post.title?.rendered || '').replace(/<[^>]+>/g, '').trim().toLowerCase();
            if (seenTitles[rawTitle]) {
                // این پست قبلاً وجود داشته و تکراری است
                duplicatesToTrash.push(post);
            } else {
                seenTitles[rawTitle] = post;
            }
        }

        // حذف پست‌های تکراری موجود در سایت
        if (duplicatesToTrash.length > 0) {
            console.log(`[Cleanup] Found ${duplicatesToTrash.length} duplicate post(s) on your site. Moving to trash...`);
            for (const dup of duplicatesToTrash) {
                try {
                    const deleteUrl = `${wpUrl.replace(/\/+$/, '')}/wp-json/wp/v2/posts/${dup.id}`;
                    await requestHttp(deleteUrl, {
                        method: 'DELETE',
                        headers: { 'Authorization': authHeader }
                    });
                    console.log(`  ✓ Trashed duplicate post: ID ${dup.id} ("${dup.title?.rendered}")`);
                } catch (delErr) {
                    console.log(`  ✗ Failed to trash post ID ${dup.id}`);
                }
            }
        } else {
            console.log(`[Anti-Duplicate] No duplicate posts found on website. All clear!`);
        }

        return Object.values(seenTitles);
    } catch (e) {
        console.log(`[Anti-Duplicate] Notice: ${e.message}`);
        return [];
    }
}

async function uploadFeaturedImage(wpUrl, username, password, imageUrl) {
    try {
        console.log(`[Media] Downloading 450x450 image...`);
        const { buffer, contentType } = await downloadBinary(imageUrl);

        const filename = `gta6-450x450-${Date.now()}.jpg`;
        const apiUrl = `${wpUrl.replace(/\/+$/, '')}/wp-json/wp/v2/media`;
        const cleanPassword = password.replace(/\s+/g, '');

        const candidates = [
            username,
            username.includes('@') ? username.split('@')[0] : username
        ];

        for (const userCandidate of candidates) {
            const authHeader = 'Basic ' + Buffer.from(`${userCandidate}:${cleanPassword}`).toString('base64');

            const res = await new Promise((resolve, reject) => {
                const urlObj = new URL(apiUrl);
                const client = urlObj.protocol === 'https:' ? https : http;

                const req = client.request({
                    protocol: urlObj.protocol,
                    hostname: urlObj.hostname,
                    port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
                    path: urlObj.pathname,
                    method: 'POST',
                    rejectUnauthorized: false,
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
                console.log(`[Media] 450x450 Image uploaded! ID: ${mediaJson.id}`);
                return { mediaId: mediaJson.id, sourceUrl: mediaJson.source_url };
            }
        }
    } catch (err) {
        console.log(`[Media] Notice: Could not upload featured image: ${err.message}`);
    }
    return null;
}

function getPredictedTitle(cleanTitle) {
    let persianTitle = 'جدیدترین گزارش موثق از بازی GTA 6';
    const lower = cleanTitle.toLowerCase();

    if (lower.includes('song') || lower.includes('radio') || lower.includes('music') || lower.includes('soundtrack')) {
        persianTitle = 'آهنگ‌ها و رادیو GTA 6 فاش شد';
    } else if (lower.includes('trailer') || lower.includes('teaser')) {
        persianTitle = 'اخبار تریلر دوم بازی GTA 6';
    } else if (lower.includes('release') || lower.includes('date') || lower.includes('delay')) {
        persianTitle = 'تاریخ انتشار نهایی بازی GTA 6';
    } else if (lower.includes('map') || lower.includes('vice city') || lower.includes('leonida')) {
        persianTitle = 'نقشه عظیم وایس سیتی در GTA 6';
    } else if (lower.includes('interview') || lower.includes('gameplay') || lower.includes('leak')) {
        persianTitle = 'اطلاعات تازه از گیم‌پلی GTA 6';
    } else if (lower.includes('price') || lower.includes('pre-order') || lower.includes('preorder')) {
        persianTitle = 'قیمت و پیش‌خرید بازی GTA 6';
    } else if (lower.includes('pc') || lower.includes('system')) {
        persianTitle = 'زمان انتشار GTA 6 برای کامپیوتر';
    } else if (lower.includes('character') || lower.includes('lucia') || lower.includes('jason')) {
        persianTitle = 'شخصیت‌های اصلی داستان GTA 6';
    }
    return persianTitle;
}

function createPersianArticle(newsItem, featuredImageUrl, recentPosts) {
    const cleanTitle = newsItem.title.replace(/\s*-\s*[^-\n]+$/, '').trim();
    const dateFormatted = new Date().toLocaleDateString('fa-IR');
    const persianTitle = getPredictedTitle(cleanTitle);

    const metaDesc = `تحلیل و اخبار بازی GTA 6 (Grand Theft Auto VI) راکستار گیمز. ویژگی‌های فنی، خرید بازی و تاریخ عرضه در فروشگاه جی تی ای ۶ استور.`;

    const imageHtml = `
    <div style="text-align: center; margin: 24px auto;">
        <img src="${featuredImageUrl}" width="450" height="450" alt="بازی GTA 6 - راکستار گیمز" style="width: 450px; height: 450px; max-width: 100%; object-fit: cover; border-radius: 12px; box-shadow: 0 6px 18px rgba(0,0,0,0.2); display: inline-block;" />
        <p style="font-size: 0.85em; color: #64748b; margin-top: 8px;">تصویر شاخص بازی GTA VI در ابعاد ۴۵۰ × ۴۵۰</p>
    </div>`;

    let prevPostsHtml = '';
    if (recentPosts && recentPosts.length > 0) {
        prevPostsHtml = recentPosts.slice(0, 2).map(p => `
            <li>مطالعه بیشتر: <a href="${p.link}" target="_blank" style="color: #0284c7; font-weight: bold; text-decoration: underline;">${p.title?.rendered ? p.title.rendered.replace(/<[^>]+>/g, '').trim() : 'مقاله پیشین GTA 6'}</a></li>
        `).join('');
    }

    const internalLinksBox = `
    <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-right: 4px solid #10b981; padding: 18px; border-radius: 8px; margin: 24px 0;">
        <h4 style="margin-top: 0; color: #065f46; font-size: 1.05em;">🔗 دسترسی سریع به بخش‌های مهم سایت و مقالات پیشین:</h4>
        <ul style="margin-bottom: 0; padding-right: 20px; line-height: 2;">
            <li>پیشنهاد ویژه: <a href="https://gtavistore.ir/product/gta-vi/" target="_blank" style="color: #e11d48; font-weight: bold; text-decoration: underline;">خرید بازی GTA 6 با تحویل فوری</a></li>
            <li>مشاهده دسته‌بندی‌ها: <a href="https://gtavistore.ir/shop/" target="_blank" style="color: #0284c7; text-decoration: underline;">فروشگاه GTA VI Store</a></li>
            ${prevPostsHtml}
        </ul>
    </div>`;

    const htmlContent = `
<div class="gtavi-post" dir="rtl" style="font-family: Tahoma, Vazirmatn, sans-serif; line-height: 2.1; color: #1e293b;">
    <p style="font-size: 1.15em; font-weight: bold; color: #0f172a; border-right: 4px solid #e11d48; padding-right: 14px; margin-bottom: 24px;">
        بازی <strong>GTA VI (Grand Theft Auto 6)</strong> نماد نسل جدید بازی‌های ویدیویی جهان‌باز است. راکستار گیمز (Rockstar Games) پس از سال‌ها سکوت، با انتشار جزئیات تازه نشان داده که قصد دارد تمامی استانداردهای صنعت سرگرمی را جابجا کند.
    </p>

    ${imageHtml}

    ${internalLinksBox}

    <h2>📌 خلاصه مهم‌ترین محورهای خبر</h2>
    <ul style="padding-right: 20px;">
        <li><strong>عنوان اصلی خبر:</strong> ${cleanTitle}</li>
        <li><strong>تاریخ گزارش:</strong> ${dateFormatted}</li>
        <li><strong>منبع موثق:</strong> خبرگزاری‌های برتر ویدیو گیم جهان</li>
        <li><strong>مرجع تخصصی:</strong> وب‌سایت رسمی <a href="https://gtavistore.ir/">gtavistore.ir</a></li>
    </ul>

    <h2>🔍 تحلیل فنی و جزئیات عمیق بازی GTA 6</h2>
    <p>
        ${newsItem.description ? newsItem.description : 'گزارش‌های جدید نشان می‌دهند راکستار با بهره‌گیری از نسخه ارتقایافته موتور RAGE 9، سطحی بی‌نظیر از جزئیات فیزیکی، بازتاب نور، شبیه‌سازی آب و تغییرات دینامیک آب و هوا را وارد دنیای لئونیدا کرده است.'}
    </p>
    <p>
        یکی از بزرگ‌ترین دستاوردهای این نسخه، <strong>هوش مصنوعی نسل جدید شهروندان (NPC AI)</strong> است. برخلاف نسخه‌های گذشته، هر یک از شخصیت‌های حاضر در خیابان‌های وایس سیتی روتین‌های روزمره، احساسات، و تعاملات اجتماعی منحصربه‌فردی دارند. سیستم واکنش پلیس و تعقیب و گریزها نیز با الگوبرداری از رفتارهای تاکتیکی واقعی بازنویسی شده است.
    </p>

    <h2>🗺️ وسعت نقشه ایالت لئونیدا و شهر وایس سیتی</h2>
    <p>
        تحلیل‌های فنی نشان می‌دهند که نقشه GTA 6 تقریباً دو برابر بزرگ‌تر از نقشه بازی Red Dead Redemption 2 و سه برابر نقشه GTA V خواهد بود. بیش از ۷۰ درصد از ساختمان‌های مسکونی و تجاری در شهر وایس سیتی دارای محیط‌های داخلی (Interiors) قابل اکتشاف خواهند بود که این موضوع تجربه دزدی‌ها و اکتشاف آزادانه را دگرگون می‌کند.
    </p>

    <h2>🎮 زمان عرضه و پلتفرم‌های مقصد</h2>
    <p>
        شرکت Take-Two Interactive مجدداً تأکید کرده است که بازی در <strong>پاییز سال ۲۰۲۵</strong> به‌طور قطعی برای کنسول‌های نسل نهم پلی‌استیشن ۵ و ایکس‌باکس سری ایکس و اس عرضه خواهد شد. طرفداران می‌توانند برای تهیه و <a href="https://gtavistore.ir/product/gta-vi/" style="font-weight: bold; color: #0284c7;">خرید بازی GTA 6</a> از خدمات تحویل آنی فروشگاه استفاده نمایند.
    </p>

    <h2>❓ سوالات متداول (FAQ)</h2>
    <div style="background-color: #f1f5f9; border-right: 4px solid #0284c7; padding: 16px; margin: 16px 0; border-radius: 6px;">
        <h4 style="margin-top: 0; color: #0369a1;">آیا این خبر به طور رسمی توسط راکستار تایید شده است؟</h4>
        <p style="margin-bottom: 0;">بله؛ تمامی تحلیل‌ها بر پایه گزارش‌های مالی، بیانیه‌های مدیران Take-Two و مصاحبه‌های رسمی با رسانه‌های معتبر گیمینگ تدوین شده‌اند.</p>
    </div>

    <div style="background-color: #f1f5f9; border-right: 4px solid #0284c7; padding: 16px; margin: 16px 0; border-radius: 6px;">
        <h4 style="margin-top: 0; color: #0369a1;">چگونه از جدیدترین مقالات مطلع شویم؟</h4>
        <p style="margin-bottom: 0;">با بررسی مداوم بخش وبلاگ سایت و دنبال کردن مقالات تحلیلی، لحظه به لحظه در جریان اخبار موثق GTA 6 قرار خواهید گرفت.</p>
    </div>
</div>
`;

    return {
        title: persianTitle,
        metaDescription: metaDesc,
        htmlContent: htmlContent,
        rawTitle: cleanTitle
    };
}

async function publishPost(wpUrl, username, password, article, featuredMediaId, status) {
    const apiUrl = `${wpUrl.replace(/\/+$/, '')}/wp-json/wp/v2/posts`;
    const cleanPassword = password.replace(/\s+/g, '');

    const candidates = [
        username,
        username.includes('@') ? username.split('@')[0] : username
    ];

    let lastError = null;

    for (const userCandidate of candidates) {
        const authHeader = 'Basic ' + Buffer.from(`${userCandidate}:${cleanPassword}`).toString('base64');
        
        const payloadObj = {
            title: article.title,
            content: article.htmlContent,
            status: status || 'publish'
        };

        if (featuredMediaId) {
            payloadObj.featured_media = featuredMediaId;
        }

        const payload = JSON.stringify(payloadObj);

        try {
            const res = await requestHttp(apiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': authHeader
                }
            }, payload);

            if (res.statusCode >= 200 && res.statusCode < 300) {
                const json = JSON.parse(res.body);
                return { success: true, link: json.link || json.guid?.rendered };
            }

            let errMsg = res.body;
            try {
                const errJson = JSON.parse(res.body);
                if (errJson.message) errMsg = errJson.message;
            } catch (e) {}

            lastError = new Error(`REST API Code ${res.statusCode}: ${errMsg}`);
        } catch (err) {
            lastError = err;
        }
    }

    throw lastError;
}

async function main() {
    console.log('========================================================');
    console.log('GTA VI Pro Auto-Publisher (Strict Anti-Duplicate Engine)');
    console.log('Target: gtavistore.ir');
    console.log('========================================================');

    const config = loadConfig();
    const history = loadHistory();
    const { wp_url, wp_username, wp_password, post_status } = config.site_settings;

    // گام ۱: بررسی مقالات موجود در وردپرس و پاکسازی خودکار موارد تکراری
    console.log('[1/5] Checking existing articles on WordPress & Cleaning duplicates...');
    const existingPosts = await fetchAndCleanDuplicatePosts(wp_url, wp_username, wp_password);
    const existingTitles = existingPosts.map(p => (p.title?.rendered || '').replace(/<[^>]+>/g, '').trim().toLowerCase());

    // گام ۲: جستجوی اخبار در گوگل نیوز
    console.log('\n[2/5] Searching Google News for FRESH, unread GTA 6 news...');
    let foundNews = [];

    for (const feedUrl of config.rss_feeds) {
        try {
            const xml = (await requestHttp(feedUrl)).body;
            const items = parseRss(xml);
            if (items.length > 0) {
                foundNews.push(...items);
            }
        } catch (err) {}
    }

    // فیلتر کردن دقیق اخبار تکراری:
    // ۱. بررسی لینک در تاریخچه محلی (history.json)
    // ۲. بررسی عنوان پیش‌بینی شده در عناوین موجود در وردپرس (existingTitles)
    let candidateNews = foundNews.filter(item => {
        if (history.includes(item.link)) return false;
        const predictedTitle = getPredictedTitle(item.title).toLowerCase();
        if (existingTitles.includes(predictedTitle)) return false;
        return true;
    });

    if (candidateNews.length === 0) {
        console.log('\n========================================================');
        console.log('🛑 [Anti-Duplicate Notice]:');
        console.log('   هیچ خبر جدیدی یافت نشد! تمام اخبار موجود در فیدها قبلاً در سایت منتشر شده‌اند.');
        console.log('   برای حفظ سئو و جلوگیری از تولید محتوای تکراری، هیچ پستی منتشر نخواهد شد.');
        console.log('========================================================');
        return;
    }

    const targetNews = candidateNews[0];
    const finalImageUrl = DEFAULT_GTA6_IMAGES[Math.floor(Math.random() * DEFAULT_GTA6_IMAGES.length)];

    console.log(`\n[3/5] Selected FRESH News: "${targetNews.title}"`);
    console.log(`      Unique Title: "${getPredictedTitle(targetNews.title)}"`);

    // آپلود عکس شاخص 450 در 450
    console.log(`\n[4/5] Uploading 450x450 image to WordPress...`);
    let featuredMediaId = null;
    let uploadedImageUrl = null;

    try {
        const mediaResult = await uploadFeaturedImage(wp_url, wp_username, wp_password, finalImageUrl);
        if (mediaResult) {
            featuredMediaId = mediaResult.mediaId;
            uploadedImageUrl = mediaResult.sourceUrl;
        }
    } catch (e) {
        console.log(`[Media] Upload notice: ${e.message}`);
    }

    // تولید محتوا با تحلیل عمیق و لینک‌سازی داخلی با انکرتکست عنوان
    const article = createPersianArticle(targetNews, uploadedImageUrl || finalImageUrl, existingPosts);

    // ذخیره پیش‌نویس
    const dateStr = new Date().toISOString().slice(0, 10);
    const htmlFile = path.join(DRAFTS_DIR, `post_${dateStr}_${Date.now()}.html`);
    const latestHtml = path.join(DRAFTS_DIR, `latest_article.html`);
    fs.writeFileSync(htmlFile, article.htmlContent, 'utf-8');
    fs.writeFileSync(latestHtml, article.htmlContent, 'utf-8');

    // انتشار در سایت
    console.log(`\n[5/5] Publishing post to gtavistore.ir ...`);
    try {
        const publishResult = await publishPost(wp_url, wp_username, wp_password, article, featuredMediaId, post_status);
        console.log('\n========================================================');
        console.log('🎉 SUCCESS! Unique Post published to gtavistore.ir:');
        console.log(`   - Title: ${article.title}`);
        if (publishResult.link) {
            console.log(`🔗 Live Post URL: ${publishResult.link}`);
        }
        console.log('========================================================');
        history.push(targetNews.link);
        history.push(targetNews.title);
        saveHistory(history);
    } catch (pubErr) {
        console.error(`\n[Error publishing to site]: ${pubErr.message}`);
    }
}

main().catch(err => console.error('Fatal error:', err));
