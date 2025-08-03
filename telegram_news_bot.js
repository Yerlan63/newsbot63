// bot.js
const https = require('https');
const { XMLParser } = require('fast-xml-parser');

// Конфигурация
const CONFIG = {
  rssFeeds: [
    'https://rss.nytimes.com/services/xml/rss/nyt/Economy.xml',
    'https://www.thenation.com/subject/politics/feed/',
    'https://moxie.foxnews.com/google-publisher/politics.xml'
  ],
  telegramBot: process.env.TELEGRAM_BOT_TOKEN,
  chatId: process.env.TELEGRAM_CHAT_ID,
  openaiKey: process.env.OPENAI_API_KEY
};

// Функция для HTTP запросов
function httpsRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data);
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        }
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

// Чтение RSS лент
async function fetchRSSFeeds() {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_"
  });
  
  const allItems = [];
  
  for (const feedUrl of CONFIG.rssFeeds) {
    try {
      console.log(`Fetching RSS: ${feedUrl}`);
      const xmlData = await httpsRequest(feedUrl);
      const parsed = parser.parse(xmlData);
      
      let items = [];
      if (parsed.rss?.channel?.item) {
        items = Array.isArray(parsed.rss.channel.item) 
          ? parsed.rss.channel.item 
          : [parsed.rss.channel.item];
      } else if (parsed.feed?.entry) {
        items = Array.isArray(parsed.feed.entry) 
          ? parsed.feed.entry 
          : [parsed.feed.entry];
      }
      
      // Нормализация данных
      const normalizedItems = items.map(item => ({
        title: item.title || item.title?.['#text'] || 'No title',
        link: item.link || item.link?.['@_href'] || '',
        pubDate: item.pubDate || item.published || new Date().toISOString(),
        content: item.description || item.summary || '',
        contentSnippet: (item.description || item.summary || '').replace(/<[^>]*>/g, '').substring(0, 120),
        creator: item['dc:creator'] || item.author?.name || 'Unknown'
      }));
      
      allItems.push(...normalizedItems);
      
    } catch (error) {
      console.error(`Error fetching ${feedUrl}:`, error.message);
    }
  }
  
  // Сортировка по дате (новые сверху)
  return allItems.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
}

// Обработка через OpenAI
async function processWithAI(newsData) {
  const prompt = `Просмотри эти данные: ${JSON.stringify(newsData)}

### ROLE
Ты — журналист-агрегатор, который формирует короткую ленту для Telegram-канала.

### CONTEXT
• Входной объект содержит новости из различных источников
• Все элементы хронологически отсортированы (новее — выше)
• Сегодня: ${new Date().toLocaleDateString('ru-RU')}

### SELECTION RULES
1. Из них выбери **до 8 самых интересных** по критерию:
   • новизна • общественная значимость • разнообразие тем
   (Не бери больше 3 заметок на одну и ту же сюжетную линию)

### OUTPUT FORMAT (Telegram-ready, Markdown)
• \`[HH:MM]\` — время из pubDate в формате UTC
• \`SNIPPET\` — краткое описание (120 символов)
• Разделяй новости пустой строкой
• Используй **жирный** заголовок, курсивный сниппет, чистую ссылку
• Всё сообщение ≤ 4096 символов

### STYLE & CONSTRAINTS
• Никакого анализа, выводов или оценок — только констатация фактов
• Не изменяй заголовок, не добавляй эмодзи кроме 🗞 и 🔗
• Не обращайся к читателю от первого лица

### EXAMPLE
🗞 [09:01] **Тарифы или сделки? Трамп довольствуется карательными пошлинами**
_Сторонники президента изображают его как человека, умеющего заключать сделки. Но пока больше партнеров получили жесткие тарифы._
🔗 https://example.com/article

ПЕРЕВОДИ ВСЕ НА РУССКИЙ ЯЗЫК`;

  const body = JSON.stringify({
    model: "gpt-3.5-turbo",
    messages: [
      {
        role: "user", 
        content: prompt
      }
    ],
    max_tokens: 2000,
    temperature: 0.3
  });

  try {
    const response = await httpsRequest('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CONFIG.openaiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      },
      body: body
    });

    const data = JSON.parse(response);
    return data.choices[0].message.content;
    
  } catch (error) {
    console.error('OpenAI API Error:', error.message);
    throw error;
  }
}

// Отправка в Telegram
async function sendToTelegram(message) {
  const body = JSON.stringify({
    chat_id: CONFIG.chatId,
    text: message,
    parse_mode: 'Markdown'
  });

  try {
    const response = await httpsRequest(`https://api.telegram.org/bot${CONFIG.telegramBot}/sendMessage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      },
      body: body
    });

    console.log('Message sent to Telegram successfully');
    return JSON.parse(response);
    
  } catch (error) {
    console.error('Telegram API Error:', error.message);
    throw error;
  }
}

// Основная функция
async function main() {
  try {
    console.log('🚀 Starting news bot...');
    
    // 1. Получение новостей
    console.log('📰 Fetching RSS feeds...');
    const newsData = await fetchRSSFeeds();
    console.log(`Found ${newsData.length} news items`);
    
    if (newsData.length === 0) {
      console.log('No news found, exiting...');
      return;
    }
    
    // 2. Обработка через AI
    console.log('🤖 Processing with AI...');
    const processedMessage = await processWithAI(newsData.slice(0, 20)); // Первые 20 новостей
    
    // 3. Отправка в Telegram
    console.log('📱 Sending to Telegram...');
    await sendToTelegram(processedMessage);
    
    console.log('✅ News bot completed successfully!');
    
  } catch (error) {
    console.error('❌ Error in main process:', error);
    process.exit(1);
  }
}

// Запуск
main();