require("dotenv").config({ quiet: true });

const { spawn } = require("node:child_process");

const {
  Client,
  GatewayIntentBits,
  PermissionsBitField,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  Events,
  AuditLogEvent,
} = require("discord.js");

const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  NoSubscriberBehavior,
  entersState,
  demuxProbe,
} = require("@discordjs/voice");

const yts = require("yt-search");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildBans,
  ],
});

const COLORS = {
  success: 0x2ecc71,
  error: 0xe74c3c,
  warning: 0xf1c40f,
  info: 0x3498db,
};

const YT_DLP_BIN = process.env.YT_DLP_PATH || "yt-dlp";
const OWNER_IDS = new Set((process.env.OWNER_IDS || "").split(",").map((id) => id.trim()).filter(Boolean));

const MUTED_ROLE_NAME = "Muted";
const ADMIN_ROLE_NAMES = new Set(["admin", "administrator", "ادمن", "أدمن"]);

const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

const SPAM_WINDOW_MS = 5000;
const SPAM_LIMIT = 10;
const SPAM_MUTE_MS = 5 * 60 * 1000;

const MASS_MENTION_LIMIT = 8;
const MASS_MENTION_MUTE_MS = 10 * 60 * 1000;
const INVITE_MUTE_MS = 10 * 60 * 1000;

const RAID_WINDOW_MS = 10 * 1000;
const RAID_JOIN_LIMIT = 6;
const RAID_MUTE_MS = 10 * 60 * 1000;

const NUKE_WINDOW_MS = 30 * 1000;
const NUKE_LIMIT = 3;
const NUKE_TIMEOUT_MS = 60 * 60 * 1000;

const PROTECTION = {
  antiSpam: true,
  antiMassMention: true,
  antiDiscordInvite: true,
  antiRaid: true,
  antiNuke: true,
};

const PUNISH_REASONS = [
  { key: "qathf", label: "قذف", emoji: "🚫", durationText: "1 ساعة", durationMs: 60 * 60 * 1000 },
  { key: "mashakel", label: "مشاكل", emoji: "⚠️", durationText: "10 دقائق", durationMs: 10 * 60 * 1000 },
  { key: "jadwala", label: "جدولة", emoji: "🕒", durationText: "5 دقائق", durationMs: 5 * 60 * 1000 },
  { key: "spam", label: "سبام", emoji: "📢", durationText: "5 دقائق", durationMs: 5 * 60 * 1000 },
  { key: "izaj", label: "إزعاج", emoji: "🔇", durationText: "15 دقيقة", durationMs: 15 * 60 * 1000 },
];

const activeTextMuteTimers = new Map();
const activeVoiceMutes = new Map();
const spamCache = new Map();
const joinCache = new Map();
const nukeCache = new Map();
const syncedMutedGuilds = new Set();
const musicQueues = new Map();

function normalizeContent(content) {
  return content.trim().replace(/\s+/g, " ");
}

function isAdmin(member) {
  if (!member) return false;
  if (member.permissions?.has(PermissionsBitField.Flags.Administrator)) return true;

  return member.roles.cache.some((role) =>
    ADMIN_ROLE_NAMES.has(role.name.trim().toLowerCase())
  );
}

function isTrustedUser(guild, user) {
  if (!user) return true;
  if (user.bot) return true;
  if (user.id === client.user?.id) return true;
  if (user.id === guild.ownerId) return true;
  if (OWNER_IDS.has(user.id)) return true;
  return false;
}

function parseCommand(content) {
  const text = normalizeContent(content);
  if (!text) return null;

  const words = text.split(" ");
  const first = words[0];
  const second = words[1] || "";
  const firstLower = first.toLowerCase();
  const lower = text.toLowerCase();

  if (lower === "clear") return { type: "clear" };
  if (lower === "skip" || lower === "s" || text === "س") return { type: "skip" };

  if (first === "فك") {
    if (second === "ميوت") return { type: "unmuteVoice" };
    if (["اسكات", "إسكات", "اسكت", "إسكت"].includes(second)) return { type: "unsilence" };
    if (second === "سجن") return { type: "unjail" };
  }

  if (first === "ميوت") return { type: "punishment", action: "voiceMute" };
  if (first === "اسكت" || first === "إسكت") return { type: "punishment", action: "textMute" };
  if (first === "سجن") return { type: "punishment", action: "jail" };

  if (first === "رول" || firstLower === "role") return { type: "role" };

  if (first === "ش" || firstLower === "p" || firstLower === "play") {
    return { type: "play", query: text.slice(first.length).trim() };
  }

  return null;
}

async function safeSend(channel, payload) {
  try {
    return await channel.send(payload);
  } catch (error) {
    console.error("[safeSend]", error.message);
    return null;
  }
}

async function safeReply(message, payload) {
  try {
    return await message.reply(payload);
  } catch {
    return safeSend(message.channel, payload);
  }
}

function errorEmbed(text) {
  return new EmbedBuilder().setColor(COLORS.error).setDescription(text);
}

function successEmbed(title) {
  return new EmbedBuilder().setColor(COLORS.success).setTitle(title);
}

async function getBotMember(guild) {
  return guild.members.me || guild.members.fetch(client.user.id);
}

async function findAlertChannel(guild) {
  const me = await getBotMember(guild).catch(() => null);
  if (!me) return null;

  const preferredNames = ["logs", "log", "mod-log", "admin-log", "حماية", "الحماية"];

  const channels = [...guild.channels.cache.values()].filter((channel) => {
    if (!channel.isTextBased?.() || typeof channel.send !== "function") return false;
    const perms = channel.permissionsFor(me);
    return perms?.has(PermissionsBitField.Flags.ViewChannel) &&
      perms?.has(PermissionsBitField.Flags.SendMessages);
  });

  return channels.find((channel) => preferredNames.includes(channel.name.toLowerCase())) ||
    guild.systemChannel ||
    channels[0] ||
    null;
}

async function sendProtectionAlert(guild, text) {
  const channel = await findAlertChannel(guild);
  if (!channel) return;

  const embed = new EmbedBuilder()
    .setColor(COLORS.warning)
    .setTitle("🛡️ حماية السيرفر")
    .setDescription(text)
    .setTimestamp();

  await safeSend(channel, { embeds: [embed] });
}

async function applyMutedOverwrite(channel, role) {
  if (!channel.permissionOverwrites?.edit) return;

  await channel.permissionOverwrites.edit(
    role,
    {
      SendMessages: false,
      SendMessagesInThreads: false,
      CreatePublicThreads: false,
      CreatePrivateThreads: false,
      AddReactions: false,
    },
    { reason: "Muted role permissions" }
  );
}

async function syncMutedPermissions(guild, role) {
  for (const channel of guild.channels.cache.values()) {
    try {
      await applyMutedOverwrite(channel, role);
    } catch (error) {
      console.error(`[muted] failed in ${channel.name}:`, error.message);
    }
  }
}

async function ensureMutedRole(guild) {
  let role = guild.roles.cache.find((r) => r.name === MUTED_ROLE_NAME);
  const me = await getBotMember(guild);

  if (!me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
    throw new Error("البوت لا يملك صلاحية Manage Roles.");
  }

  if (!role) {
    role = await guild.roles.create({
      name: MUTED_ROLE_NAME,
      color: 0x2f3136,
      permissions: [],
      reason: "Create Muted role",
    });
  }

  if (me.roles.highest.comparePositionTo(role) <= 0) {
    throw new Error("رتبة البوت لازم تكون أعلى من رتبة Muted.");
  }

  if (!syncedMutedGuilds.has(guild.id)) {
    await syncMutedPermissions(guild, role);
    syncedMutedGuilds.add(guild.id);
  }

  return role;
}

function clearTextMuteTimer(guildId, userId, roleId) {
  const key = `${guildId}:${userId}:${roleId}`;
  const timer = activeTextMuteTimers.get(key);
  if (timer) clearTimeout(timer);
  activeTextMuteTimers.delete(key);
}

function scheduleTextMuteRemoval(guildId, userId, roleId, durationMs) {
  clearTextMuteTimer(guildId, userId, roleId);

  const key = `${guildId}:${userId}:${roleId}`;
  const timer = setTimeout(async () => {
    activeTextMuteTimers.delete(key);

    try {
      const guild = await client.guilds.fetch(guildId).catch(() => null);
      if (!guild) return;

      const member = await guild.members.fetch(userId).catch(() => null);
      if (!member) return;

      if (member.roles.cache.has(roleId)) {
        await member.roles.remove(roleId, "انتهت مدة الاسكات الكتابي");
      }
    } catch (error) {
      console.error("[scheduleTextMuteRemoval]", error);
    }
  }, durationMs);

  activeTextMuteTimers.set(key, timer);
}

async function textMuteMember(member, durationMs, reasonText) {
  const role = await ensureMutedRole(member.guild);
  const me = await getBotMember(member.guild);

  if (member.id === member.guild.ownerId) {
    throw new Error("لا يمكن إسكات مالك السيرفر.");
  }

  if (me.roles.highest.comparePositionTo(member.roles.highest) <= 0) {
    throw new Error("رتبة البوت لازم تكون أعلى من رتبة العضو.");
  }

  await member.roles.add(role, reasonText);
  scheduleTextMuteRemoval(member.guild.id, member.id, role.id, durationMs);
  return role;
}

function clearVoiceMuteTimer(guildId, userId) {
  const key = `${guildId}:${userId}`;
  const item = activeVoiceMutes.get(key);
  if (item?.timer) clearTimeout(item.timer);
  activeVoiceMutes.delete(key);
}

function scheduleVoiceUnmute(guildId, userId, durationMs) {
  clearVoiceMuteTimer(guildId, userId);

  const key = `${guildId}:${userId}`;
  const expiresAt = Date.now() + durationMs;

  const timer = setTimeout(async () => {
    activeVoiceMutes.delete(key);

    try {
      const guild = await client.guilds.fetch(guildId).catch(() => null);
      if (!guild) return;

      const member = await guild.members.fetch(userId).catch(() => null);
      if (!member?.voice?.channel) return;

      await member.voice.setMute(false, "انتهت مدة الميوت الصوتي");
    } catch (error) {
      console.error("[scheduleVoiceUnmute]", error.message);
    }
  }, durationMs);

  activeVoiceMutes.set(key, { timer, expiresAt });
}

async function voiceMuteMember(member, durationMs, reasonText) {
  if (!member.voice?.channel) {
    throw new Error("العضو لازم يكون داخل روم صوتي.");
  }

  const me = await getBotMember(member.guild);
  const voicePerms = member.voice.channel.permissionsFor(me);

  if (!voicePerms?.has(PermissionsBitField.Flags.MuteMembers)) {
    throw new Error("البوت يحتاج صلاحية Mute Members في الروم الصوتي.");
  }

  if (member.id === member.guild.ownerId) {
    throw new Error("لا يمكن عمل ميوت صوتي لمالك السيرفر.");
  }

  if (me.roles.highest.comparePositionTo(member.roles.highest) <= 0) {
    throw new Error("رتبة البوت لازم تكون أعلى من رتبة العضو.");
  }

  await member.voice.setMute(true, reasonText);
  scheduleVoiceUnmute(member.guild.id, member.id, durationMs);
}

function buildPunishmentMenu(action, target, requesterId) {
  const titleByAction = {
    voiceMute: "📋 اختر سبب الميوت الصوتي",
    textMute: "📋 اختر سبب الاسكات",
    jail: "📋 اختر سبب السجن",
  };

  const wordByAction = {
    voiceMute: "الميوت الصوتي",
    textMute: "الاسكات",
    jail: "السجن",
  };

  const embed = new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle(titleByAction[action])
    .setDescription(`العضو: ${target}`);

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`punish:${action}:${target.id}:${requesterId}`)
    .setPlaceholder("اختر السبب")
    .addOptions(
      PUNISH_REASONS.map((reason) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(`${reason.label} — ${reason.durationText}`)
          .setValue(reason.key)
          .setEmoji(reason.emoji)
      )
    );

  return {
    content: `اختر سبب ${wordByAction[action]} للعضو ${target}`,
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(menu)],
  };
}

async function sendPunishmentMenu(message, action) {
  const target = message.mentions.members.first();

  if (!target) {
    const example =
      action === "voiceMute" ? "ميوت @user" :
      action === "textMute" ? "اسكت @user" :
      "سجن @user";

    return safeReply(message, `مثال صحيح: ${example}`);
  }

  return safeReply(message, buildPunishmentMenu(action, target, message.author.id));
}

async function handlePunishmentInteraction(interaction) {
  const [, action, targetId, requesterId] = interaction.customId.split(":");

  if (interaction.user.id !== requesterId) {
    return interaction.reply({
      content: "❌ هذه القائمة ليست لك.",
      ephemeral: true,
    }).catch(() => {});
  }

  await interaction.deferUpdate();

  const actor = interaction.member?.roles?.cache
    ? interaction.member
    : await interaction.guild.members.fetch(interaction.user.id).catch(() => null);

  if (!isAdmin(actor)) {
    return interaction.editReply({
      content: "❌ هذا الأمر مسموح فقط للأدمن.",
      embeds: [],
      components: [],
    });
  }

  const reason = PUNISH_REASONS.find((item) => item.key === interaction.values[0]);
  if (!reason) {
    return interaction.editReply({
      content: "",
      embeds: [errorEmbed("❌ السبب غير صحيح.")],
      components: [],
    });
  }

  const target = await interaction.guild.members.fetch(targetId).catch(() => null);
  if (!target) {
    return interaction.editReply({
      content: "",
      embeds: [errorEmbed("⚠️ العضو غير موجود أو خرج من السيرفر.")],
      components: [],
    });
  }

  try {
    if (action === "voiceMute") {
      await voiceMuteMember(target, reason.durationMs, reason.label);
    }

    if (action === "textMute") {
      await textMuteMember(target, reason.durationMs, reason.label);
    }

    if (action === "jail") {
      const me = await getBotMember(interaction.guild);

      if (!me.permissions.has(PermissionsBitField.Flags.ModerateMembers)) {
        throw new Error("البوت لا يملك صلاحية Moderate Members.");
      }

      if (!target.moderatable) {
        throw new Error("لا أستطيع سجن هذا العضو بسبب ترتيب الرتب.");
      }

      await target.timeout(reason.durationMs, reason.label);
    }

    const titleByAction = {
      voiceMute: "✅ تم تنفيذ الميوت",
      textMute: "✅ تم تنفيذ الاسكات",
      jail: "✅ تم تنفيذ السجن",
    };

    const typeByAction = {
      voiceMute: "ميوت صوتي",
      textMute: "إسكات كتابة فقط",
      jail: "Timeout",
    };

    const embed = successEmbed(titleByAction[action]).addFields(
      { name: "العضو", value: `${target}`, inline: true },
      { name: "السبب", value: reason.label, inline: true },
      { name: "المدة", value: reason.durationText, inline: true },
      { name: "النوع", value: typeByAction[action], inline: false }
    );

    return interaction.editReply({
      content: "",
      embeds: [embed],
      components: [],
    });
  } catch (error) {
    console.error("[punishment]", error);

    return interaction.editReply({
      content: "",
      embeds: [errorEmbed(`❌ ${error.message || "حصل خطأ أثناء تنفيذ العقوبة."}`)],
      components: [],
    });
  }
}

async function handleUnpunish(message, type) {
  const target = message.mentions.members.first();

  if (!target) {
    const example =
      type === "voice" ? "فك ميوت @user" :
      type === "text" ? "فك اسكات @user" :
      "فك سجن @user";

    return safeReply(message, `مثال صحيح: ${example}`);
  }

  try {
    if (type === "voice") {
      clearVoiceMuteTimer(message.guild.id, target.id);

      if (!target.voice?.channel) {
        return safeReply(message, `⚠️ ${target} ليس داخل روم صوتي الآن. تم حذف مؤقت الميوت إن وجد.`);
      }

      await target.voice.setMute(false, "فك الميوت الصوتي");
      return safeReply(message, `✅ تم فك الميوت عن ${target}`);
    }

    if (type === "jail") {
      await target.timeout(null, "فك السجن");
      return safeReply(message, `✅ تم فك السجن عن ${target}`);
    }

    const role = message.guild.roles.cache.find((r) => r.name === MUTED_ROLE_NAME);

    if (role && target.roles.cache.has(role.id)) {
      await target.roles.remove(role, "فك الاسكات");
      clearTextMuteTimer(message.guild.id, target.id, role.id);
    }

    return safeReply(message, `✅ تم فك الاسكات عن ${target}`);
  } catch (error) {
    console.error("[unpunish]", error);
    return safeReply(message, `❌ ${error.message || "حصل خطأ أثناء فك العقوبة."}`);
  }
}

async function handleClear(message) {
  const me = await getBotMember(message.guild);
  const perms = message.channel.permissionsFor(me);

  if (!perms?.has(PermissionsBitField.Flags.ManageMessages)) {
    return safeReply(message, "❌ البوت يحتاج صلاحية Manage Messages.");
  }

  try {
    const messages = await message.channel.messages.fetch({ limit: 30 });
    const freshMessages = messages.filter(
      (msg) => Date.now() - msg.createdTimestamp < FOURTEEN_DAYS_MS && msg.deletable
    );

    if (freshMessages.size === 0) {
      return safeReply(message, "⚠️ لا توجد رسائل حديثة قابلة للحذف.");
    }

    const deleted = await message.channel.bulkDelete(freshMessages, true);
    const reply = await safeSend(message.channel, `✅ تم حذف ${deleted.size} رسالة.`);

    if (reply) setTimeout(() => reply.delete().catch(() => {}), 5000);
  } catch (error) {
    console.error("[clear]", error);

    if (error.code === 50034) {
      return safeReply(message, "⚠️ لا توجد رسائل حديثة قابلة للحذف.");
    }

    return safeReply(message, "❌ حصل خطأ أثناء حذف الرسائل.");
  }
}

async function handleRoleCommand(message) {
  const target = message.mentions.members.first();

  if (!target) {
    return safeReply(message, "مثال صحيح: رول @user اسم الرتبة");
  }

  const commandWord = normalizeContent(message.content).split(" ")[0];
  const args = normalizeContent(message.content).slice(commandWord.length).trim();
  const roleMention = message.mentions.roles.first();
  const roleName = args.replace(/<@!?\d+>/, "").replace(/<@&\d+>/, "").trim();

  const role =
    roleMention ||
    message.guild.roles.cache.find((r) => r.name.toLowerCase() === roleName.toLowerCase());

  if (!role) return safeReply(message, "❌ لم أجد رتبة بهذا الاسم.");
  if (role.id === message.guild.id) return safeReply(message, "❌ لا يمكن إعطاء رتبة everyone.");
  if (role.managed) return safeReply(message, "❌ هذه رتبة خاصة ولا يمكن إدارتها.");

  try {
    const me = await getBotMember(message.guild);

    if (!me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
      return safeReply(message, "❌ البوت يحتاج صلاحية Manage Roles.");
    }

    if (me.roles.highest.comparePositionTo(role) <= 0) {
      return safeReply(message, "❌ رتبة البوت لازم تكون أعلى من الرتبة المطلوبة.");
    }

    if (target.roles.cache.has(role.id)) {
      return safeReply(message, `⚠️ ${target} لديه هذه الرتبة بالفعل.`);
    }

    await target.roles.add(role, `Role command by ${message.author.tag}`);
    return safeReply(message, `✅ تم إعطاء رتبة ${role.name} إلى ${target}`);
  } catch (error) {
    console.error("[role]", error);
    return safeReply(message, "❌ حصل خطأ أثناء إعطاء الرتبة.");
  }
}

async function deleteMessageQuietly(message) {
  try {
    if (message.deletable) await message.delete();
  } catch (error) {
    console.error("[deleteMessageQuietly]", error.message);
  }
}

function hasDiscordInvite(content) {
  return /(discord\.gg\/|discord\.com\/invite\/|discordapp\.com\/invite\/)/i.test(content);
}

async function handleMessageProtection(message, member) {
  if (!message.guild || message.author.bot || isAdmin(member)) return false;

  if (PROTECTION.antiDiscordInvite && hasDiscordInvite(message.content)) {
    await deleteMessageQuietly(message);

    try {
      await textMuteMember(member, INVITE_MUTE_MS, "حماية: نشر دعوة Discord");
      await safeSend(message.channel, `${member} تم إسكاتك 10 دقائق بسبب نشر دعوة Discord.`);
    } catch (error) {
      console.error("[antiInvite]", error.message);
    }

    return true;
  }

  const mentionCount = message.mentions.users.size + message.mentions.roles.size;

  if (PROTECTION.antiMassMention && mentionCount >= MASS_MENTION_LIMIT) {
    await deleteMessageQuietly(message);

    try {
      await textMuteMember(member, MASS_MENTION_MUTE_MS, "حماية: منشن جماعي");
      await safeSend(message.channel, `${member} تم إسكاتك 10 دقائق بسبب المنشن الجماعي.`);
    } catch (error) {
      console.error("[antiMassMention]", error.message);
    }

    return true;
  }

  if (PROTECTION.antiSpam) {
    const now = Date.now();
    const key = `${message.guild.id}:${message.author.id}`;
    const old = spamCache.get(key) || [];
    const recent = old.filter((time) => now - time <= SPAM_WINDOW_MS);

    recent.push(now);
    spamCache.set(key, recent);

    if (recent.length >= SPAM_LIMIT) {
      spamCache.set(key, []);

      try {
        await textMuteMember(member, SPAM_MUTE_MS, "حماية: سبام");
        await safeSend(message.channel, `${member} تم إسكاتك 5 دقائق بسبب السبام.`);
      } catch (error) {
        console.error("[antiSpam]", error.message);
      }

      return true;
    }
  }

  return false;
}

async function handleRaidProtection(member) {
  if (!PROTECTION.antiRaid || member.user.bot) return;

  const now = Date.now();
  const key = member.guild.id;
  const old = joinCache.get(key) || [];
  const recent = old.filter((join) => now - join.time <= RAID_WINDOW_MS);

  recent.push({ id: member.id, time: now });
  joinCache.set(key, recent);

  const accountAgeDays = Math.floor((Date.now() - member.user.createdTimestamp) / (24 * 60 * 60 * 1000));

  if (accountAgeDays < 3) {
    await sendProtectionAlert(
      member.guild,
      `⚠️ حساب جديد دخل السيرفر: ${member}\nعمر الحساب: ${accountAgeDays} يوم`
    );
  }

  if (recent.length >= RAID_JOIN_LIMIT) {
    try {
      await textMuteMember(member, RAID_MUTE_MS, "حماية: دخول جماعي");
      await sendProtectionAlert(
        member.guild,
        `🚨 تم رصد دخول جماعي: ${recent.length} أعضاء خلال ${RAID_WINDOW_MS / 1000} ثواني.\nتم إسكات ${member} مؤقتًا.`
      );
    } catch (error) {
      console.error("[antiRaid]", error.message);
      await sendProtectionAlert(member.guild, `🚨 تم رصد دخول جماعي، لكن فشل تطبيق الحماية: ${error.message}`);
    }
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getAuditExecutor(guild, type, targetId) {
  try {
    await wait(1200);

    const me = await getBotMember(guild);
    if (!me.permissions.has(PermissionsBitField.Flags.ViewAuditLog)) return null;

    const logs = await guild.fetchAuditLogs({ limit: 5, type });
    const entry = logs.entries.find((item) => {
      const sameTarget = !targetId || item.target?.id === targetId;
      const recent = Date.now() - item.createdTimestamp < 8000;
      return sameTarget && recent;
    });

    return entry?.executor || null;
  } catch (error) {
    console.error("[getAuditExecutor]", error.message);
    return null;
  }
}

async function protectFromNuke(guild, executor, actionName) {
  if (!PROTECTION.antiNuke || isTrustedUser(guild, executor)) return;

  const now = Date.now();
  const key = `${guild.id}:${executor.id}`;
  const old = nukeCache.get(key) || [];
  const recent = old.filter((item) => now - item.time <= NUKE_WINDOW_MS);

  recent.push({ action: actionName, time: now });
  nukeCache.set(key, recent);

  if (recent.length < NUKE_LIMIT) return;

  try {
    const member = await guild.members.fetch(executor.id).catch(() => null);
    if (!member) {
      return sendProtectionAlert(guild, `🚨 تم رصد نشاط خطير من ${executor.tag}: ${actionName}`);
    }

    const me = await getBotMember(guild);

    if (me.roles.highest.comparePositionTo(member.roles.highest) <= 0) {
      return sendProtectionAlert(
        guild,
        `🚨 تم رصد نشاط خطير من ${member} لكن رتبة البوت ليست أعلى منه.\nالإجراء: ${actionName}`
      );
    }

    const dangerousPerms = new PermissionsBitField([
      PermissionsBitField.Flags.Administrator,
      PermissionsBitField.Flags.ManageGuild,
      PermissionsBitField.Flags.ManageChannels,
      PermissionsBitField.Flags.ManageRoles,
      PermissionsBitField.Flags.BanMembers,
      PermissionsBitField.Flags.KickMembers,
      PermissionsBitField.Flags.ManageMessages,
      PermissionsBitField.Flags.ModerateMembers,
      PermissionsBitField.Flags.ManageWebhooks,
    ]);

    const removableRoles = member.roles.cache.filter((role) => {
      if (role.id === guild.id || role.managed) return false;
      if (me.roles.highest.comparePositionTo(role) <= 0) return false;
      return role.permissions.any(dangerousPerms);
    });

    if (removableRoles.size > 0) {
      await member.roles.remove([...removableRoles.keys()], "حماية السيرفر من التخريب");
    }

    if (member.moderatable && me.permissions.has(PermissionsBitField.Flags.ModerateMembers)) {
      await member.timeout(NUKE_TIMEOUT_MS, "حماية السيرفر من التخريب");
    }

    await sendProtectionAlert(
      guild,
      `🚨 حماية التخريب اشتغلت على ${member}\nالإجراء المرصود: ${actionName}\nتمت محاولة إزالة الرتب الخطيرة وتطبيق Timeout.`
    );

    nukeCache.set(key, []);
  } catch (error) {
    console.error("[antiNuke]", error);
    await sendProtectionAlert(guild, `🚨 فشل تنفيذ حماية التخريب: ${error.message}`);
  }
}

function cleanTitle(title) {
  return String(title || "أغنية").replace(/[`*_~|]/g, "");
}

function buildYoutubeUrl(video) {
  if (video.videoId) return `https://www.youtube.com/watch?v=${video.videoId}`;
  return video.url;
}

function killProcess(proc) {
  try {
    if (proc && !proc.killed) proc.kill("SIGKILL");
  } catch {}
}

async function createYoutubeResource(song) {
  const args = [
    "--no-playlist",
    "--quiet",
    "--no-warnings",
    "--force-ipv4",
    "-f",
    "ba[ext=webm][acodec^=opus]/ba[ext=m4a]/ba/b",
    "-o",
    "-",
  ];

  if (process.env.YT_DLP_COOKIES) {
    args.push("--cookies", process.env.YT_DLP_COOKIES);
  }

  args.push(song.url);

  const proc = spawn(YT_DLP_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });

  let settled = false;
  let stderr = "";

  proc.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
    if (stderr.length > 4000) stderr = stderr.slice(-4000);
  });

  const processFailed = new Promise((_, reject) => {
    proc.once("error", (error) => {
      if (settled) return;

      if (error.code === "ENOENT") {
        reject(new Error(`yt-dlp غير مثبت أو YT_DLP_PATH غير صحيح: ${YT_DLP_BIN}`));
      } else {
        reject(error);
      }
    });

    proc.once("close", (code) => {
      if (settled || code === 0) return;
      reject(new Error(stderr.trim() || `yt-dlp exited with code ${code}`));
    });
  });

  processFailed.catch(() => {});

  try {
    const probed = await Promise.race([demuxProbe(proc.stdout), processFailed]);
    settled = true;

    const resource = createAudioResource(probed.stream, {
      inputType: probed.type,
      metadata: song,
    });

    if (resource.playStream) {
      resource.playStream.once("close", () => killProcess(proc));
      resource.playStream.once("error", () => killProcess(proc));
    }

    return resource;
  } catch (error) {
    settled = true;
    killProcess(proc);
    throw error;
  }
}

function cleanupMusicQueue(guildId) {
  const queue = musicQueues.get(guildId);
  if (!queue) return;

  queue.destroyed = true;

  try {
    queue.player.stop(true);
  } catch {}

  try {
    queue.connection.destroy();
  } catch {}

  musicQueues.delete(guildId);
}

async function advanceQueue(queue) {
  if (queue.advancing || queue.destroyed) return;

  queue.advancing = true;

  try {
    await playNext(queue);
  } catch (error) {
    console.error("[music advance]", error);
    await safeSend(queue.textChannel, "⚠️ حصل خطأ في قائمة التشغيل.");
    cleanupMusicQueue(queue.guildId);
  } finally {
    queue.advancing = false;
  }
}

function wireMusicQueue(queue) {
  queue.player.on(AudioPlayerStatus.Idle, () => {
    if (queue.destroyed || queue.skipNextIdle) return;

    queue.current = null;
    queue.playing = false;
    advanceQueue(queue);
  });

  queue.player.on("error", async (error) => {
    console.error("[music player]", error);

    queue.skipNextIdle = true;
    queue.current = null;
    queue.playing = false;

    await safeSend(queue.textChannel, "⚠️ حصل خطأ في الأغنية، بحاول أشغل التالية.");
    await advanceQueue(queue);

    setTimeout(() => {
      queue.skipNextIdle = false;
    }, 1000);
  });

  queue.connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(queue.connection, VoiceConnectionStatus.Signalling, 5000),
        entersState(queue.connection, VoiceConnectionStatus.Connecting, 5000),
      ]);
    } catch {
      cleanupMusicQueue(queue.guildId);
    }
  });

  queue.connection.on("error", (error) => {
    console.error("[voice connection]", error);
  });
}

async function getOrCreateMusicQueue(message, voiceChannel) {
  let queue = musicQueues.get(message.guild.id);

  if (queue && !queue.destroyed) {
    queue.textChannel = message.channel;
    queue.voiceChannel = voiceChannel;
    return queue;
  }

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: message.guild.id,
    adapterCreator: message.guild.voiceAdapterCreator,
    selfDeaf: false,
  });

  const player = createAudioPlayer({
    behaviors: {
      noSubscriber: NoSubscriberBehavior.Play,
    },
  });

  connection.subscribe(player);

  queue = {
    guildId: message.guild.id,
    textChannel: message.channel,
    voiceChannel,
    connection,
    player,
    songs: [],
    current: null,
    playing: false,
    advancing: false,
    destroyed: false,
    skipNextIdle: false,
  };

  musicQueues.set(message.guild.id, queue);
  wireMusicQueue(queue);

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20000);
  } catch {
    cleanupMusicQueue(message.guild.id);
    throw new Error("فشل الدخول للروم الصوتي.");
  }

  return queue;
}

async function playNext(queue) {
  if (queue.destroyed) return;

  const song = queue.songs.shift();

  if (!song) {
    await safeSend(queue.textChannel, "✅ انتهت القائمة، خرجت من الروم.");
    cleanupMusicQueue(queue.guildId);
    return;
  }

  queue.current = song;
  queue.playing = true;

  try {
    const resource = await createYoutubeResource(song);

    if (queue.destroyed) return;

    queue.player.play(resource);
    await safeSend(queue.textChannel, `🎵 بدأ تشغيل: **${cleanTitle(song.title)}**`);
  } catch (error) {
    console.error("[playNext]", error);

    await safeSend(
      queue.textChannel,
      `⚠️ ما قدرت أشغل: **${cleanTitle(song.title)}**\n${String(error.message || error).slice(0, 300)}`
    );

    queue.current = null;
    queue.playing = false;

    await playNext(queue);
  }
}

async function handlePlay(message, query) {
  if (!query) return safeReply(message, "مثال صحيح: play اسم الأغنية");

  const voiceChannel = message.member?.voice?.channel;
  if (!voiceChannel) return safeReply(message, "❌ ادخل روم صوتي أولاً.");

  const me = await getBotMember(message.guild);
  const permissions = voiceChannel.permissionsFor(me);

  if (
    !permissions?.has(PermissionsBitField.Flags.Connect) ||
    !permissions?.has(PermissionsBitField.Flags.Speak)
  ) {
    return safeReply(message, "❌ البوت يحتاج صلاحيات Connect و Speak في الروم الصوتي.");
  }

  try {
    const result = await yts(query);
    const video = result.videos?.find((item) => item.url && !item.live) || result.videos?.[0];

    if (!video) return safeReply(message, "❌ ما لقيت نتيجة في YouTube.");

    const song = {
      title: video.title,
      url: buildYoutubeUrl(video),
      duration: video.timestamp || "غير معروف",
      requestedBy: message.author.id,
    };

    const queue = await getOrCreateMusicQueue(message, voiceChannel);
    queue.songs.push(song);

    if (queue.current || queue.playing) {
      return safeReply(message, `✅ تمت الإضافة للقائمة: **${cleanTitle(song.title)}**`);
    }

    await advanceQueue(queue);
  } catch (error) {
    console.error("[play]", error);
    return safeReply(message, `❌ حصل خطأ أثناء البحث أو التشغيل.\n${String(error.message || error).slice(0, 300)}`);
  }
}

async function handleSkip(message) {
  const queue = musicQueues.get(message.guild.id);

  if (!queue || !queue.current || queue.player.state.status === AudioPlayerStatus.Idle) {
    return safeReply(message, "ما في أغنية شغالة.");
  }

  queue.player.stop(true);
  return safeReply(message, "✅ تم تخطي الأغنية.");
}

client.once(Events.ClientReady, (readyClient) => {
  console.log(`✅ Logged in as ${readyClient.user.tag}`);
});

client.on(Events.MessageCreate, async (message) => {
  try {
    if (!message.guild || message.author.bot) return;

    const member =
      message.member ||
      await message.guild.members.fetch(message.author.id).catch(() => null);

    const command = parseCommand(message.content);

    if (!command) {
      await handleMessageProtection(message, member);
      return;
    }

    if (!isAdmin(member)) {
      return safeReply(message, "❌ هذا الأمر مسموح فقط للأدمن.");
    }

    if (command.type === "punishment") return sendPunishmentMenu(message, command.action);
    if (command.type === "unmuteVoice") return handleUnpunish(message, "voice");
    if (command.type === "unsilence") return handleUnpunish(message, "text");
    if (command.type === "unjail") return handleUnpunish(message, "jail");
    if (command.type === "clear") return handleClear(message);
    if (command.type === "role") return handleRoleCommand(message);
    if (command.type === "play") return handlePlay(message, command.query);
    if (command.type === "skip") return handleSkip(message);
  } catch (error) {
    console.error("[messageCreate]", error);
    return safeReply(message, "⚠️ حصل خطأ أثناء تنفيذ الأمر.");
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (!interaction.isStringSelectMenu()) return;
    if (!interaction.customId.startsWith("punish:")) return;

    return handlePunishmentInteraction(interaction);
  } catch (error) {
    console.error("[interactionCreate]", error);

    if (interaction.deferred || interaction.replied) {
      return interaction.editReply({
        content: "",
        embeds: [errorEmbed("⚠️ حصل خطأ أثناء تنفيذ الاختيار.")],
        components: [],
      }).catch(() => {});
    }

    return interaction.reply({
      content: "⚠️ حصل خطأ أثناء تنفيذ الاختيار.",
      ephemeral: true,
    }).catch(() => {});
  }
});

client.on(Events.GuildMemberAdd, async (member) => {
  try {
    const channel = member.guild.channels.cache.find(
      (ch) => ch.name === "welcome" && ch.isTextBased?.()
    );

    if (channel) {
      await safeSend(channel, `أهلاً وسهلاً بك ${member} في السيرفر!`);
    }

    await handleRaidProtection(member);
  } catch (error) {
    console.error("[guildMemberAdd]", error);
  }
});

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  try {
    if (!newState.guild || !newState.member || newState.member.user.bot) return;

    const key = `${newState.guild.id}:${newState.member.id}`;
    const item = activeVoiceMutes.get(key);
    if (!item) return;

    if (!newState.channel) return;

    if (Date.now() >= item.expiresAt) {
      clearVoiceMuteTimer(newState.guild.id, newState.member.id);
      await newState.setMute(false, "انتهت مدة الميوت الصوتي");
      return;
    }

    if (!newState.serverMute) {
      await newState.setMute(true, "استمرار الميوت الصوتي");
    }
  } catch (error) {
    console.error("[voiceStateUpdate]", error.message);
  }
});

client.on(Events.ChannelCreate, async (channel) => {
  try {
    if (!channel.guild) return;

    const role = channel.guild.roles.cache.find((r) => r.name === MUTED_ROLE_NAME);
    if (role) await applyMutedOverwrite(channel, role);

    const executor = await getAuditExecutor(channel.guild, AuditLogEvent.ChannelCreate, channel.id);
    if (executor) await protectFromNuke(channel.guild, executor, "إنشاء رومات بسرعة");
  } catch (error) {
    console.error("[channelCreate]", error);
  }
});

client.on(Events.ChannelDelete, async (channel) => {
  try {
    if (!channel.guild) return;

    const executor = await getAuditExecutor(channel.guild, AuditLogEvent.ChannelDelete, channel.id);
    if (executor) await protectFromNuke(channel.guild, executor, "حذف رومات بسرعة");
  } catch (error) {
    console.error("[channelDelete]", error);
  }
});

client.on(Events.RoleCreate, async (role) => {
  try {
    const executor = await getAuditExecutor(role.guild, AuditLogEvent.RoleCreate, role.id);
    if (executor) await protectFromNuke(role.guild, executor, "إنشاء رتب بسرعة");
  } catch (error) {
    console.error("[roleCreate]", error);
  }
});

client.on(Events.RoleDelete, async (role) => {
  try {
    const executor = await getAuditExecutor(role.guild, AuditLogEvent.RoleDelete, role.id);
    if (executor) await protectFromNuke(role.guild, executor, "حذف رتب بسرعة");
  } catch (error) {
    console.error("[roleDelete]", error);
  }
});

client.on(Events.GuildBanAdd, async (ban) => {
  try {
    const executor = await getAuditExecutor(ban.guild, AuditLogEvent.MemberBanAdd, ban.user.id);
    if (executor) await protectFromNuke(ban.guild, executor, "باندات متكررة");
  } catch (error) {
    console.error("[guildBanAdd]", error);
  }
});

client.on("error", (error) => {
  console.error("[client error]", error);
});

client.on("warn", (warning) => {
  console.warn("[client warn]", warning);
});

process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});

process.on("uncaughtException", (error) => {
  console.error("[uncaughtException]", error);
});

if (!process.env.TOKEN) {
  console.error("❌ TOKEN غير موجود في ملف .env");
  process.exit(1);
}

client.login(process.env.TOKEN).catch((error) => {
  console.error("[login]", error);
});