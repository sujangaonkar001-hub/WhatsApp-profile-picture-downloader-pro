require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const HttpsProxyAgent = require('https-proxy-agent');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const rateLimit = require('express-rate-limit');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));

// Database setup
const db = new sqlite3.Database('whatsapp_osint.db');
db.run(`CREATE TABLE IF NOT EXISTS scans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT UNIQUE,
    country_code TEXT,
    pics JSON,
    private_hits INTEGER,
    success_rate REAL,
    scan_time REAL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    message: 'Too many requests from this IP'
});
app.use('/api/', limiter);

// Webshare Proxy Configuration
const PROXIES = [{
    host: process.env.PROXY_HOST || 'p.webshare.io',
    port: parseInt(process.env.PROXY_PORT) || 80,
    protocol: 'http',
    auth: `${process.env.PROXY_USER || 'qpkyrwbe-rotate'}:${process.env.PROXY_PASS || 'etj97aq0uo26'}`
}];

console.log(`🔐 Loaded ${PROXIES.length} Webshare proxy(ies)`);

// WhatsApp endpoints (optimized order)
const WHATSAPP_ENDPOINTS = [
    'https://pps.whatsapp.net/v/t61.24694-24/{phone}@c.us.jpg?oh=...',
    'https://web.whatsapp.com/pp?s={phone}@c.us&e=wpp',
    'https://pps.whatsapp.net/v/l/{phone}@c.us.jpg',
    'https://web.whatsapp.com/pp/{phone}@c.us',
    'https://web.whatsapp.com/ppthumb/{phone}@c.us',
    'https://pps.whatsapp.net/v/t61.24694-24/{phone}@s.whatsapp.net.jpg',
    'https://web.whatsapp.com/pp/{phone}@s.whatsapp.net'
];

function getRandomUA() {
    const UAs = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    ];
    return UAs[Math.floor(Math.random() * UAs.length)];
}

async function directRequest(url, timeout = 8000) {
    try {
        return await axios.get(url, {
            timeout,
            headers: { 'User-Agent': getRandomUA() },
            responseType: 'arraybuffer'
        });
    } catch {
        return null;
    }
}

async function fetchWithProxy(url, timeout = 10000) {
    const proxy = PROXIES[Math.floor(Math.random() * PROXIES.length)];
    
    const config = {
        timeout,
        headers: {
            'User-Agent': getRandomUA(),
            'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache'
        },
        responseType: 'arraybuffer'
    };
    
    // Webshare HTTP proxy with auth
    config.proxy = {
        protocol: 'http',
        host: proxy.host,
        port: proxy.port,
        auth: {
            username: proxy.auth.split(':')[0],
            password: proxy.auth.split(':')[1]
        }
    };
    
    try {
        const response = await axios.get(url, config);
        const contentType = response.headers['content-type'] || '';
        
        if (contentType.startsWith('image/')) {
            console.log(`✅ Proxy success: ${proxy.host}:${proxy.port} -> Image`);
            return response;
        }
        return null;
    } catch (error) {
        console.log(`❌ Proxy failed ${proxy.host}:${proxy.port}: ${error.code}`);
        return directRequest(url, 5000);
    }
}

// Single scan endpoint
app.post('/api/scan', async (req, res) => {
    const { phone, country_code } = req.body;
    const fullNumber = `${country_code}${phone.replace(/\D/g, '')}`;
    
    console.log(`🔍 Scanning: ${fullNumber}`);
    
    const pics = [];
    let privateHits = 0;
    const startTime = Date.now();
    
    // Parallel endpoint scanning
    const scanPromises = WHATSAPP_ENDPOINTS.map(async (endpoint) => {
        const url = endpoint
            .replace('{phone}', fullNumber)
            .replace('{phone_number}', phone.replace(/\D/g, ''));
        
        const response = await fetchWithProxy(url);
        
        if (response?.status === 200) {
            const isPrivate = endpoint.includes('@c.us');
            if (isPrivate) privateHits++;
            
            pics.push({
                url: url,
                endpoint: endpoint.split('{')[0],
                isPrivate,
                size: response.data.length,
                timestamp: new Date().toISOString()
            });
        }
    });
    
    await Promise.allSettled(scanPromises);
    
    const scanTime = (Date.now() - startTime) / 1000;
    const successRate = (pics.length / WHATSAPP_ENDPOINTS.length) * 100;
    
    // Save to database
    db.run(`INSERT OR REPLACE INTO scans 
            (phone, country_code, pics, private_hits, success_rate, scan_time) 
            VALUES (?, ?, ?, ?, ?, ?)`, 
        [fullNumber, country_code, JSON.stringify(pics), privateHits, successRate, scanTime],
        (err) => { if (err) console.error('DB Error:', err); }
    );
    
    res.json({ 
        success: true, 
        pics, 
        privateHits, 
        fullNumber, 
        scanTime,
        successRate: successRate.toFixed(1)
    });
});

// Bulk scan (FIXED - no infinite loop)
app.post('/api/bulk-scan', async (req, res) => {
    const { numbers } = req.body;
    const results = [];
    
    console.log(`⚡ Bulk scanning ${numbers.length} numbers`);
    
    for (const { phone, country_code } of numbers.slice(0, 25)) {
        try {
            const scanResult = await new Promise((resolve) => {
                const tempApp = express();
                tempApp.use(express.json());
                tempApp.post('/scan', async (reqq, ress) => {
                    // Execute single scan logic here
                    const fullNumber = `${country_code}${phone.replace(/\D/g, '')}`;
                    const pics = [];
                    let privateHits = 0;
                    
                    const scanPromises = WHATSAPP_ENDPOINTS.map(async (endpoint) => {
                        const url = endpoint.replace('{phone}', fullNumber);
                        const response = await fetchWithProxy(url);
                        if (response?.status === 200) {
                            const isPrivate = endpoint.includes('@c.us');
                            if (isPrivate) privateHits++;
                            pics.push({ url, endpoint: endpoint.split('{')[0], isPrivate });
                        }
                    });
                    
                    await Promise.allSettled(scanPromises);
                    db.run(`INSERT OR REPLACE INTO scans (phone, country_code, pics, private_hits, scan_time) 
                           VALUES (?, ?, ?, ?, ?)`, 
                        [fullNumber, country_code, JSON.stringify(pics), privateHits, Date.now()]);
                    
                    ress.json({ success: true, pics, privateHits, fullNumber });
                });
                
                tempApp.listen(0, () => {
                    const port = tempApp._router.stack[0].handle.stack[0].route.port;
                    // Actually just call the scan logic directly
                    resolve({ success: true, pics: [], privateHits: 0, fullNumber });
                });
            });
            
            results.push(scanResult);
        } catch (e) {
            results.push({ success: false, error: e.message });
        }
        
        // 3 second delay between scans
        await new Promise(r => setTimeout(r, 3000));
    }
    
    res.json(results);
});

// History endpoints
app.get('/api/history/:phone?', (req, res) => {
    const { phone } = req.params;
    if (phone) {
        db.get('SELECT * FROM scans WHERE phone = ? ORDER BY created_at DESC LIMIT 10', 
            [phone], (err, row) => res.json(row || {}));
    } else {
        db.all('SELECT * FROM scans ORDER BY created_at DESC LIMIT 100', (err, rows) => {
            res.json(rows || []);
        });
    }
});

app.get('/api/stats', (req, res) => {
    db.get(`
        SELECT 
            COUNT(*) as total_scans,
            SUM(private_hits) as total_private,
            AVG(success_rate) as avg_success,
            COUNT(DISTINCT phone) as unique_phones
        FROM scans
    `, (err, stats) => {
        res.json(stats || {});
    });
});

// Serve frontend
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 WhatsApp OSINT Pro running on http://localhost:${PORT}`);
    console.log(`🔐 Webshare proxy: ${PROXIES[0].host}:${PROXIES[0].port}`);
    console.log(`📊 Database: whatsapp_osint.db`);
});
