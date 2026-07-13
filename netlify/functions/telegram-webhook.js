/**
 * Netlify Function: обрабатывает webhook-обновления от Telegram.
 *
 * Логика:
 * - Смотрит на нового участника чата (chat_member) или на автора сообщения
 *   (message) и сверяет имя/фамилию/username с "запрещёнными" паттернами.
 * - Если совпало — банит пользователя через Telegram Bot API (banChatMember)
 *   и, если это было сообщение, удаляет его.
 *
 * Переменные окружения (задаются в Netlify -> Site settings -> Environment
 * variables):
 *   BOT_TOKEN        - токен бота от @BotFather
 *   WEBHOOK_SECRET   - произвольная строка-секрет для проверки заголовка
 *                      X-Telegram-Bot-Api-Secret-Token (защита от чужих
 *                      запросов на твой webhook URL)
 */

// ---------------------------------------------------------------------------
// НАСТРОЙКА: список фраз/паттернов, при совпадении с которыми юзер банится.
// ---------------------------------------------------------------------------
const BANNED_PATTERNS = [
  /лучш\w*\s*маркетолог\w*\s*снг/i,
  /лучш\w*\s*таргетолог\w*\s*снг/i,
  /лучш\w*\s*смм\w*\s*снг/i,
  /top\s*marketer\s*cis/i,
  // добавляй сюда новые варианты по мере появления
];

// Таблица похожих латинских букв -> кириллица (частый способ обхода фильтров)
const HOMOGLYPHS = {
  a: "а", e: "е", o: "о", p: "р", c: "с",
  x: "х", y: "у", k: "к", m: "м", t: "т",
  H: "Н", B: "В", A: "А",
};

function normalize(text) {
  if (!text) return "";
  let normalized = text.normalize("NFKC");
  normalized = normalized
    .split("")
    .map((ch) => HOMOGLYPHS[ch] || ch)
    .join("");
  normalized = normalized.toLowerCase();
  normalized = normalized.replace(/[\s\-_.]+/g, " ").trim();
  return normalized;
}

function isBannedName(...parts) {
  const fullName = normalize(parts.filter(Boolean).join(" "));
  return BANNED_PATTERNS.some((pattern) => pattern.test(fullName));
}

async function telegramApi(method, params) {
  const token = process.env.BOT_TOKEN;
  const url = `https://api.telegram.org/bot${token}/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (!data.ok) {
    console.error(`Telegram API error (${method}):`, data);
  }
  return data;
}

async function banUser(chatId, userId, reason) {
  console.log(`Баню user_id=${userId} в chat_id=${chatId}. Причина: ${reason}`);
  return telegramApi("banChatMember", { chat_id: chatId, user_id: userId });
}

exports.handler = async (event) => {
  // Проверка секрета, чтобы левые запросы не могли дёргать функцию
  const secret = process.env.WEBHOOK_SECRET;
  if (secret) {
    const incoming = event.headers["x-telegram-bot-api-secret-token"];
    if (incoming !== secret) {
      return { statusCode: 401, body: "Unauthorized" };
    }
  }

  let update;
  try {
    update = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, body: "Bad Request" };
  }

  try {
    // Случай 1: кто-то вступил в чат / сменил статус
    if (update.chat_member) {
      const newMember = update.chat_member.new_chat_member;
      if (newMember && ["member", "restricted"].includes(newMember.status)) {
        const user = newMember.user;
        if (isBannedName(user.first_name, user.last_name, user.username)) {
          await banUser(
            update.chat_member.chat.id,
            user.id,
            `ник при вступлении: ${user.first_name} ${user.last_name || ""} @${user.username || ""}`
          );
        }
      }
    }

    // Случай 2: обычное сообщение (на случай смены ника после вступления)
    if (update.message) {
      const message = update.message;
      const user = message.from;
      if (user && isBannedName(user.first_name, user.last_name, user.username)) {
        await telegramApi("deleteMessage", {
          chat_id: message.chat.id,
          message_id: message.message_id,
        });
        await banUser(
          message.chat.id,
          user.id,
          `ник в сообщении: ${user.first_name} ${user.last_name || ""} @${user.username || ""}`
        );
      }
    }
  } catch (e) {
    console.error("Ошибка обработки update:", e);
  }

  // Telegram ждёт быстрый 200 OK, иначе будет ретраить
  return { statusCode: 200, body: "OK" };
};
