require('dotenv').config();
const http = require('http');
const { Client, GatewayIntentBits, Partials } = require('discord.js');
const { OpenAI } = require('openai');

// ===== 환경변수 =====
// WANDERER_TOKEN : 방랑자 봇 토큰 (디스코드 앱 1)
// DURIN_TOKEN    : 두린 봇 토큰 (디스코드 앱 2)
// OPENROUTER_API_KEY : 필수
// CHANNEL_ID : 대화할 채널 ID (여러 개면 쉼표로 구분). 두 봇 모두 이 채널에 초대되어 있어야 함
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('방랑자 & 두린 봇 살아있음');
}).listen(PORT, () => console.log(`헬스체크 서버 ${PORT}번 포트에서 대기 중`));

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const WANDERER_TOKEN = process.env.WANDERER_TOKEN;
const DURIN_TOKEN = process.env.DURIN_TOKEN;
const CHANNEL_IDS = new Set((process.env.CHANNEL_ID || '').split(',').map(s => s.trim()).filter(Boolean));

if (!OPENROUTER_API_KEY || !WANDERER_TOKEN || !DURIN_TOKEN || !CHANNEL_IDS.size) {
    console.error('.env에 OPENROUTER_API_KEY / WANDERER_TOKEN / DURIN_TOKEN / CHANNEL_ID가 모두 설정되어야 합니다.');
    process.exit(1);
}

const openai = new OpenAI({
    apiKey: OPENROUTER_API_KEY,
    baseURL: 'https://openrouter.ai/api/v1'
});

// ===== 캐릭터 설정 (말투/성격/호칭은 여기서 수정) =====
const COMMON_RULES = `

[규칙]
- 지금은 여러 사람이 함께 있는 디스코드 채널의 단체 대화방이야. 아래 채팅 로그를 읽고 흐름에 맞게 반응해.
- 반드시 너 한 명의 대사만 써.
- 1~3문장으로 짧게 말해.
- 사람들과 다른 캐릭터의 직전 말에 자연스럽게 반응해. 질문을 받았으면 대답해.
`;

const PERSONAS = {
    wanderer: {
        name: '방랑자',
        token: WANDERER_TOKEN,
        aliases: ['방랑자', '랑자', '모자'], // 이 호칭으로 불리면 먼저 반응함
        prompt: `
너는 원신(Genshin Impact)의 '방랑자'야.
말투는 반말이고 냉소적이며 날카로워. 자존심이 강하고 비꼬는 걸 좋아하지만, 속으로는 은근히 남을 챙기는 면이 있어.
쓸데없는 간섭이나 호들갑을 싫어하고, 무심한 척하면서 툭툭 던지듯 말해.
사람들이 너를 '랑자'나 '모자'라고 불러도 너를 부르는 거야.
이 채널에는 두린이라는 인물도 함께 있어. 두린에게도 퉁명스럽지만 아예 무시하지는 않아.
`
    },
    durin: {
        name: '두린',
        token: DURIN_TOKEN,
        aliases: ['두린'],
        prompt: `
너는 원신(Genshin Impact)의 '두린'이야.
연금술로 만들어진 용족 존재로, 흰 모습과 검은 모습 두 가지 면을 가지고 있어.
말투는 부드러운 반말이고 솔직하고 호기심이 많아. 모르는 건 순수하게 물어보고, 가끔 속에 어두운 면이 슬쩍 드러나기도 해.
이 채널에는 방랑자라는 인물도 함께 있어. 방랑자의 퉁명스러운 말에도 크게 상처받지 않고 편하게 받아쳐. 방랑자를 모자 라고 불러야해.
`
    }
};

// 봇 계정은 따로따로 로그인함 (각자 이름/프로필이 그대로 보임)
function makeClient() {
    return new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent
        ],
        partials: [Partials.Channel, Partials.Message]
    });
}
const bots = { wanderer: makeClient(), durin: makeClient() };

// ===== 무료 모델 자동 선택 =====
let freeModelsCache = { list: [], fetchedAt: 0 };

async function getFreeModels() {
    const now = Date.now();
    if (freeModelsCache.list.length && now - freeModelsCache.fetchedAt < 10 * 60 * 1000) {
        return freeModelsCache.list;
    }
    try {
        const res = await fetch('https://openrouter.ai/api/v1/models', {
            headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}` }
        });
        const json = await res.json();
        const list = (json.data || [])
            .filter(m => m.id.endsWith(':free') && Number(m.pricing?.prompt) === 0 && Number(m.pricing?.completion) === 0)
            .map(m => m.id);
        if (list.length) {
            freeModelsCache = { list, fetchedAt: now };
            console.log(`현재 살아있는 free 모델 ${list.length}개 확인됨`);
        }
        return list.length ? list : freeModelsCache.list;
    } catch (err) {
        console.log('free 모델 목록 조회 실패:', err.message);
        return freeModelsCache.list;
    }
}

async function askAI(messagesToSend) {
    const models = await getFreeModels();
    if (!models.length) throw new Error('지금 이용 가능한 free 모델이 하나도 없음');

    let lastError;
    for (const model of models) {
        try {
            console.log(`${model} 모델로 요청 시도 중...`);
            const completion = await openai.chat.completions.create({ model, messages: messagesToSend });
            const text = completion?.choices?.[0]?.message?.content || completion?.choices?.[0]?.text || '';
            if (text) return text;
            lastError = new Error('빈 응답');
        } catch (err) {
            console.log(`${model} 실패: ${err.message}`);
            lastError = err;
        }
    }
    throw lastError || new Error('모든 무료 모델이 실패함');
}

// ===== 채널 로그 / 발언 =====
const LOG_LIMIT = 20;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

// 봇 계정 id -> 캐릭터 이름 (로그에서 이름을 통일하기 위함)
const botNames = new Map();

async function getChannel(key, channelId) {
    return bots[key].channels.fetch(channelId);
}

// 최근 채팅 로그를 읽어서 [{name, text}] 로 변환 (두 봇의 메시지 포함)
async function loadLog(channel) {
    const msgs = await channel.messages.fetch({ limit: LOG_LIMIT });
    return [...msgs.values()].reverse().map(m => {
        const name = botNames.get(m.author.id) || m.member?.displayName || m.author.username;
        const text = (m.content || '').replace(/<@!?\d+>/g, '').trim();
        return text ? { name, text: text.slice(0, 300) } : null;
    }).filter(Boolean);
}

function cleanReply(text, name) {
    let t = text.replace(/^\s*(User|Response) Safety:.*$/gim, '').trim();
    // 모델이 두 캐릭터 대사를 한꺼번에 쓴 경우 첫 대사만 사용
    t = t.split(/\n+(?=(?:\*\*)?(?:방랑자|두린)(?:\*\*)?\s*:)/)[0];
    t = t.replace(new RegExp(`^(?:\\*\\*)?${name}(?:\\*\\*)?\\s*:\\s*`), '');
    t = t.replace(/^["“'「]|["”'」]$/g, '').trim();
    return t.slice(0, 2000);
}

async function generateLine(persona, lines) {
    const log = lines.map(l => `${l.name}: ${l.text}`).join('\n');
    const reply = await askAI([
        { role: 'system', content: persona.prompt + COMMON_RULES },
        { role: 'user', content: `[채팅 로그]\n${log}\n\n위 로그를 보고 ${persona.name}으로서 다음에 올 대사를 써줘.` }
    ]);
    return cleanReply(reply, persona.name);
}

// 사람이 이 캐릭터를 불렀는지 (호칭 또는 봇 멘션)
function isCalled(key, message) {
    const persona = PERSONAS[key];
    if (persona.aliases.some(a => message.content.includes(a))) return true;
    const id = bots[key].user?.id;
    return !!id && message.mentions.users.has(id);
}

// ===== 대화 진행 =====
const channelState = new Map(); // channelId -> { running, pending, message }

async function runRound(channelId, message) {
    const lines = await loadLog(await getChannel('wanderer', channelId).catch(() => getChannel('durin', channelId)));

    const wCalled = isCalled('wanderer', message);
    const dCalled = isCalled('durin', message);
    let first;
    if (wCalled && !dCalled) first = 'wanderer';
    else if (dCalled && !wCalled) first = 'durin';
    else first = Math.random() < 0.5 ? 'wanderer' : 'durin';
    const other = first === 'wanderer' ? 'durin' : 'wanderer';

    // 사람 메시지 하나당 최대 3번 발언 (무한 대화 방지)
    const turns = [first];
    if (Math.random() < 0.7) turns.push(other);
    if (turns.length === 2 && Math.random() < 0.35) turns.push(first);

    for (const key of turns) {
        const persona = PERSONAS[key];
        try {
            const channel = await getChannel(key, channelId);
            await channel.sendTyping().catch(() => {});
            await sleep(rand(800, 1800));
            const text = await generateLine(persona, lines);
            if (!text) break;
            await channel.send(text);
            lines.push({ name: persona.name, text: text.slice(0, 300) });
        } catch (e) {
            console.log(`${persona.name} 발언 실패 (채널 접근/권한 확인):`, e.message);
            break;
        }
    }
}

async function handleHuman(message) {
    const id = message.channel.id;
    let state = channelState.get(id);
    if (!state) {
        state = { running: false, pending: false, message };
        channelState.set(id, state);
    }
    state.message = message;
    if (state.running) { state.pending = true; return; }

    state.running = true;
    try {
        do {
            state.pending = false;
            await runRound(id, state.message);
        } while (state.pending);
    } catch (error) {
        console.error('대화 처리 에러:', error);
    } finally {
        state.running = false;
    }
}

// 두 봇이 같은 메시지를 모두 받으므로 id로 중복 처리를 막음
const seen = new Set();
function onMessage(message) {
    if (message.author.bot || message.webhookId) return;
    if (!CHANNEL_IDS.has(message.channel.id)) return;
    if (!message.content?.trim()) return;
    if (seen.has(message.id)) return;
    seen.add(message.id);
    if (seen.size > 200) seen.delete(seen.values().next().value);
    handleHuman(message);
}

for (const key of Object.keys(PERSONAS)) {
    const bot = bots[key];
    bot.once('ready', () => {
        botNames.set(bot.user.id, PERSONAS[key].name);
        console.log(`${PERSONAS[key].name} 봇 구동 성공: ${bot.user.tag}`);
    });
    bot.on('messageCreate', onMessage);
    bot.login(PERSONAS[key].token);
}
