require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  ChannelType,
  PermissionsBitField,
  REST,
  Routes,
  SlashCommandBuilder
} = require('discord.js');

const sqlite3 = require('sqlite3').verbose();

// ===== DATABASE (Railway safe path)
const db = new sqlite3.Database('./data.sqlite');

// Create tables
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS config (
      guildId TEXT PRIMARY KEY,
      categoryId TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS counters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guildId TEXT,
      type TEXT,
      roleId TEXT,
      channelId TEXT,
      name TEXT
    )
  `);
});

// ===== CLIENT
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
});

// ===== SLASH COMMANDS
const commands = [
  new SlashCommandBuilder().setName('setup').setDescription('Create counters'),

  new SlashCommandBuilder()
    .setName('add-role')
    .setDescription('Add role counter')
    .addRoleOption(opt =>
      opt.setName('role').setDescription('Role').setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('remove-counter')
    .setDescription('Remove a counter')
    .addChannelOption(opt =>
      opt.setName('channel').setDescription('Counter channel').setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('edit-counter')
    .setDescription('Edit counter name')
    .addChannelOption(opt =>
      opt.setName('channel').setDescription('Channel').setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName('name')
        .setDescription('New name (use {count})')
        .setRequired(true)
    ),

  new SlashCommandBuilder().setName('update').setDescription('Update counters')
].map(c => c.toJSON());

// ===== REGISTER COMMANDS (INSTANT)
const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);

(async () => {
  try {
    await rest.put(
      Routes.applicationGuildCommands(
        process.env.CLIENT_ID,
        process.env.GUILD_ID
      ),
      { body: commands }
    );
    console.log('✅ Slash commands ready');
  } catch (err) {
    console.error(err);
  }
})();

// ===== READY
client.once('ready', () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
});

// ===== HELPERS
function getCategory(guildId) {
  return new Promise((resolve) => {
    db.get(`SELECT categoryId FROM config WHERE guildId = ?`, [guildId], (err, row) => {
      resolve(row?.categoryId || null);
    });
  });
}

function getCounters(guildId) {
  return new Promise((resolve) => {
    db.all(`SELECT * FROM counters WHERE guildId = ?`, [guildId], (err, rows) => {
      resolve(rows || []);
    });
  });
}

async function createChannel(guild, categoryId, name) {
  return guild.channels.create({
    name,
    type: ChannelType.GuildVoice,
    parent: categoryId,
    permissionOverwrites: [
      {
        id: guild.roles.everyone,
        allow: ['ViewChannel'],
        deny: ['Connect']
      }
    ]
  });
}

// ===== UPDATE COUNTERS
async function updateCounters(guild) {
  await guild.members.fetch();
  const counters = await getCounters(guild.id);

  for (const c of counters) {
    const channel = guild.channels.cache.get(c.channelId);
    if (!channel) continue;

    let count = 0;

    if (c.type === 'members') count = guild.memberCount;
    if (c.type === 'bots') count = guild.members.cache.filter(m => m.user.bot).size;
    if (c.type === 'role') {
      const role = guild.roles.cache.get(c.roleId);
      if (!role) continue;
      count = role.members.size;
    }

    const newName = c.name.replace('{count}', count);
    channel.setName(newName).catch(() => {});
  }
}

// ===== INTERACTIONS
client.on('interactionCreate', async (i) => {
  if (!i.isChatInputCommand()) return;

  if (!i.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
    return i.reply({ content: '❌ Admin only', ephemeral: true });
  }

  const guild = i.guild;

  // ===== SETUP
  if (i.commandName === 'setup') {
    const category = await guild.channels.create({
      name: '📊 Server Stats',
      type: ChannelType.GuildCategory
    });

    db.run(`INSERT OR REPLACE INTO config VALUES (?, ?)`,
      [guild.id, category.id]
    );

    const members = await createChannel(guild, category.id, '👥 Members: 0');
    const bots = await createChannel(guild, category.id, '🤖 Bots: 0');

    db.run(`INSERT INTO counters (guildId,type,roleId,channelId,name) VALUES (?,?,?,?,?)`,
      [guild.id, 'members', null, members.id, '👥 Members: {count}']
    );

    db.run(`INSERT INTO counters (guildId,type,roleId,channelId,name) VALUES (?,?,?,?,?)`,
      [guild.id, 'bots', null, bots.id, '🤖 Bots: {count}']
    );

    i.reply('✅ Setup complete!');
    updateCounters(guild);
  }

  // ===== ADD ROLE
  if (i.commandName === 'add-role') {
    const role = i.options.getRole('role');
    const categoryId = await getCategory(guild.id);

    if (!categoryId) return i.reply('Run /setup first');

    const ch = await createChannel(guild, categoryId, `🎭 ${role.name}: 0`);

    db.run(`INSERT INTO counters (guildId,type,roleId,channelId,name) VALUES (?,?,?,?,?)`,
      [guild.id, 'role', role.id, ch.id, `🎭 ${role.name}: {count}`]
    );

    i.reply('✅ Role counter added');
    updateCounters(guild);
  }

  // ===== REMOVE
  if (i.commandName === 'remove-counter') {
    const channel = i.options.getChannel('channel');

    db.run(`DELETE FROM counters WHERE channelId = ?`, [channel.id]);
    channel.delete().catch(() => {});

    i.reply('🗑️ Counter removed');
  }

  // ===== EDIT
  if (i.commandName === 'edit-counter') {
    const channel = i.options.getChannel('channel');
    const name = i.options.getString('name');

    db.run(`UPDATE counters SET name = ? WHERE channelId = ?`,
      [name, channel.id]
    );

    i.reply('✏️ Counter updated');
    updateCounters(guild);
  }

  // ===== UPDATE
  if (i.commandName === 'update') {
    await updateCounters(guild);
    i.reply('🔄 Updated!');
  }
});

// ===== AUTO UPDATE
client.on('guildMemberAdd', m => updateCounters(m.guild));
client.on('guildMemberRemove', m => updateCounters(m.guild));

// ===== START
client.login(process.env.TOKEN);