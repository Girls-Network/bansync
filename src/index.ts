import { 
  Client, 
  GatewayIntentBits, 
  Guild, 
  EmbedBuilder, 
  Colors,
  SlashCommandBuilder,
  REST,
  Routes,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  TextChannel
} from 'discord.js';
import { readFileSync } from 'fs';
import { join } from 'path';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildModeration, // For ban events
  ],
});

const TOKEN = process.env.DISCORD_TOKEN;

if (!TOKEN) {
  console.error('Error: DISCORD_TOKEN environment variable is not set!');
  process.exit(1);
}

// Track bans currently being processed to prevent loops
// Format: "userId-guildId" -> timestamp
const processingBans = new Map<string, number>();
const BAN_PROCESSING_TIMEOUT = 30000; // 30 seconds
const BAN_DELAY_MS = 1000; // 1 second delay between bans to different servers

// Helper to create a unique key for a ban
function getBanKey(userId: string, guildId: string): string {
  return `${userId}-${guildId}`;
}

// Helper to check if a ban is currently being processed
function isBanProcessing(userId: string, guildId: string): boolean {
  const key = getBanKey(userId, guildId);
  const timestamp = processingBans.get(key);
  
  if (!timestamp) return false;
  
  // Check if the processing has timed out
  if (Date.now() - timestamp > BAN_PROCESSING_TIMEOUT) {
    processingBans.delete(key);
    return false;
  }
  
  return true;
}

// Helper to mark a ban as being processed
function markBanProcessing(userId: string, guildId: string): void {
  const key = getBanKey(userId, guildId);
  processingBans.set(key, Date.now());
}

// Helper to unmark a ban as being processed
function unmarkBanProcessing(userId: string, guildId: string): void {
  const key = getBanKey(userId, guildId);
  processingBans.delete(key);
}

// Cleanup old processing entries every minute
setInterval(() => {
  const now = Date.now();
  for (const [key, timestamp] of processingBans.entries()) {
    if (now - timestamp > BAN_PROCESSING_TIMEOUT) {
      processingBans.delete(key);
    }
  }
}, 60000);

interface ServerConfig {
  id: string;
  name: string;
  logChannelId: string | null;
}

interface ServersConfig {
  servers: ServerConfig[];
}

interface BanResult {
  serverId: string;
  serverName: string;
  success: boolean;
  alreadyBanned: boolean;
  error?: string;
}

interface UnbanResult {
  serverId: string;
  serverName: string;
  success: boolean;
  wasNotBanned: boolean;
  error?: string;
}

interface SyncStats {
  totalBans: number;
  newBans: number;
  alreadyBanned: number;
  errors: number;
  details: Map<string, { user: string; results: BanResult[] }>;
}

// Load server configuration
let serversConfig: ServersConfig;
try {
  // Try root directory first, then src directory
  let configPath = join(process.cwd(), 'servers.json');
  let configFile: string;
  
  try {
    configFile = readFileSync(configPath, 'utf-8');
  } catch {
    // If not found in root, try src directory
    configPath = join(process.cwd(), 'src', 'servers.json');
    configFile = readFileSync(configPath, 'utf-8');
  }
  
  serversConfig = JSON.parse(configFile);
  
  if (!serversConfig.servers || !Array.isArray(serversConfig.servers)) {
    throw new Error('Invalid servers.json format');
  }
  
  console.log(`✅ Loaded configuration from: ${configPath}`);
} catch (error) {
  console.error('❌ Error loading servers.json:', error);
  console.error('Please ensure servers.json exists in either the root directory or src/ directory and is properly formatted.');
  process.exit(1);
}

// Create a map for quick lookup
const serverMap = new Map<string, ServerConfig>(
  serversConfig.servers.map(s => [s.id, s])
);

// Helper function to send logs to configured logging channels
async function sendLog(serverId: string, embed: EmbedBuilder) {
  const serverConfig = serverMap.get(serverId);
  if (!serverConfig || !serverConfig.logChannelId) {
    return; // No logging channel configured
  }

  const guild = client.guilds.cache.get(serverId);
  if (!guild) {
    return;
  }

  try {
    const logChannel = await guild.channels.fetch(serverConfig.logChannelId);
    
    if (!logChannel || !logChannel.isTextBased()) {
      console.log(`⚠️  Log channel not found or not text-based in ${serverConfig.name}`);
      return;
    }

    const textChannel = logChannel as TextChannel;
    
    // Check if bot has permission to send messages
    if (!textChannel.permissionsFor(client.user!)?.has('SendMessages')) {
      console.log(`⚠️  No permission to send messages in log channel for ${serverConfig.name}`);
      return;
    }

    await textChannel.send({ embeds: [embed] });
  } catch (error) {
    console.error(`❌ Failed to send log to ${serverConfig.name}:`, error);
  }
}

// Helper function to send logs to all configured servers
async function sendLogToAll(embed: EmbedBuilder) {
  for (const server of serversConfig.servers) {
    await sendLog(server.id, embed);
  }
}

// Define slash commands
const commands = [
  new SlashCommandBuilder()
    .setName('sync')
    .setDescription('Sync all bans across configured servers')
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName('unban')
    .setDescription('Unban a user from all configured servers')
    .addStringOption(option =>
      option.setName('user_id')
        .setDescription('The ID of the user to unban')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('reason')
        .setDescription('Reason for unbanning')
        .setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .setDMPermission(false),
].map(command => command.toJSON());

// Register slash commands
async function registerCommands() {
  if (!TOKEN) return; // Should never happen due to early exit, but satisfies TypeScript
  
  const rest = new REST().setToken(TOKEN);
  
  try {
    console.log('🔄 Started refreshing global application (/) commands.');
    console.log('⏳ Note: Global commands can take up to 1 hour to sync across all servers.');
    
    // Register commands globally instead of per-guild
    await rest.put(
      Routes.applicationCommands(client.user!.id),
      { body: commands }
    );
    
    console.log('✅ Successfully registered global commands.');
    console.log('   Commands will be available in all servers within an hour.');
  } catch (error) {
    console.error('❌ Error registering commands:', error);
  }
}

client.once('clientReady', async () => {
  console.log(`✅ Logged in as ${client.user?.tag}`);
  console.log(`📊 Configured servers:`);
  
  for (const server of serversConfig.servers) {
    const guild = client.guilds.cache.get(server.id);
    const logStatus = server.logChannelId ? `📝 Log: ${server.logChannelId}` : '⚠️  No log channel';
    if (guild) {
      // Check bot permissions
      const botMember = await guild.members.fetch(client.user!.id);
      const hasAdminPerms = botMember.permissions.has(PermissionFlagsBits.Administrator);
      const hasBanPerms = botMember.permissions.has(PermissionFlagsBits.BanMembers);
      const permStatus = hasAdminPerms ? '👑 Admin' : hasBanPerms ? '✅ Can Ban' : '❌ Cannot Ban';
      console.log(`  ✔️  ${server.name} (${server.id}) - ${permStatus} - ${logStatus}`);
    } else {
      console.log(`  ❌ ${server.name} (${server.id}) - Bot not in this server!`);
    }
  }
  
  // Register slash commands
  await registerCommands();
});

// Handle slash commands
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  
  if (interaction.commandName === 'sync') {
    await handleSyncCommand(interaction);
  } else if (interaction.commandName === 'unban') {
    await handleUnbanCommand(interaction);
  }
});

async function handleUnbanCommand(interaction: ChatInputCommandInteraction) {
  // Check if user has ban permissions
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.BanMembers)) {
    await interaction.reply({
      content: '❌ You need Ban Members permission to use this command.',
      ephemeral: true,
    });
    return;
  }
  
  const userId = interaction.options.getString('user_id', true);
  const reason = interaction.options.getString('reason') || 'No reason provided';
  
  // Validate user ID format
  if (!/^\d{17,19}$/.test(userId)) {
    await interaction.reply({
      content: '❌ Invalid user ID format. Please provide a valid Discord user ID.',
      ephemeral: true,
    });
    return;
  }
  
  await interaction.deferReply();
  
  try {
    console.log(`\n🔓 Unban initiated by ${interaction.user.tag} in ${interaction.guild?.name}`);
    console.log(`   User ID: ${userId}`);
    console.log(`   Reason: ${reason}`);
    
    const results: UnbanResult[] = [];
    
    // Try to unban from all servers
    for (const configServer of serversConfig.servers) {
      const guild = client.guilds.cache.get(configServer.id);
      
      if (!guild) {
        results.push({
          serverId: configServer.id,
          serverName: configServer.name,
          success: false,
          wasNotBanned: false,
          error: 'Bot not in server',
        });
        continue;
      }
      
      try {
        // Check if bot has ban permissions
        const botMember = await guild.members.fetch(client.user!.id);
        if (!botMember.permissions.has(PermissionFlagsBits.BanMembers)) {
          results.push({
            serverId: configServer.id,
            serverName: configServer.name,
            success: false,
            wasNotBanned: false,
            error: 'Missing Permissions',
          });
          console.log(`  ❌ Missing ban permission in ${configServer.name}`);
          continue;
        }
        
        // Check if user is actually banned
        const existingBan = await guild.bans.fetch(userId).catch(() => null);
        
        if (!existingBan) {
          results.push({
            serverId: configServer.id,
            serverName: configServer.name,
            success: true,
            wasNotBanned: true,
          });
          continue;
        }
        
        // Unban the user
        await guild.members.unban(userId, `[BanSync Unban] ${reason} | Requested by ${interaction.user.tag}`);
        
        results.push({
          serverId: configServer.id,
          serverName: configServer.name,
          success: true,
          wasNotBanned: false,
        });
        
        console.log(`  ✅ Unbanned from ${configServer.name}`);
        
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        results.push({
          serverId: configServer.id,
          serverName: configServer.name,
          success: false,
          wasNotBanned: false,
          error: errorMessage,
        });
        console.log(`  ❌ Failed to unban from ${configServer.name}: ${errorMessage}`);
      }
    }
    
    // Calculate stats
    const unbannedCount = results.filter(r => r.success && !r.wasNotBanned).length;
    const notBannedCount = results.filter(r => r.wasNotBanned).length;
    const errorCount = results.filter(r => !r.success).length;
    
    // Format results for embed
    const resultText = results
      .map(r => {
        const emoji = r.success ? '✔️' : '❌';
        const status = r.wasNotBanned ? ' (not banned)' : r.error ? ` (${r.error})` : '';
        return `${r.serverName}: ${emoji}${status}`;
      })
      .join('\n');
    
    // Create summary embed
    const embed = new EmbedBuilder()
      .setTitle('🔓 Unban Complete')
      .setDescription(`Processed unban for user ID \`${userId}\` across ${serversConfig.servers.length} servers.`)
      .addFields(
        { name: 'User ID', value: `<@${userId}> (\`${userId}\`)`, inline: false },
        { name: 'Reason', value: reason, inline: false },
        { name: 'Requested By', value: `${interaction.user.tag} (<@${interaction.user.id}>)`, inline: false },
        { name: 'Results', value: resultText || 'None', inline: false },
        {
          name: 'Summary',
          value: `✅ Unbanned: ${unbannedCount}\n⚠️ Not banned: ${notBannedCount}\n❌ Errors: ${errorCount}`,
          inline: false,
        }
      )
      .setColor(errorCount > 0 ? Colors.Orange : Colors.Green)
      .setTimestamp()
      .setFooter({ text: `Requested by ${interaction.user.tag}` });
    
    await interaction.editReply({
      embeds: [embed],
    });
    
    // Send log to all configured logging channels
    await sendLogToAll(embed);
    
    console.log(`\n✅ Unban complete:`);
    console.log(`   Unbanned: ${unbannedCount}`);
    console.log(`   Not banned: ${notBannedCount}`);
    console.log(`   Errors: ${errorCount}`);
    
  } catch (error) {
    console.error('❌ Error during unban:', error);
    await interaction.editReply({
      content: '❌ An error occurred during the unban process. Check the logs for details.',
    });
  }
}

async function handleSyncCommand(interaction: ChatInputCommandInteraction) {
  // Check if user has ban permissions
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.BanMembers)) {
    await interaction.reply({
      content: '❌ You need Ban Members permission to use this command.',
      ephemeral: true,
    });
    return;
  }
  
  await interaction.deferReply();
  
  try {
    console.log(`\n🔄 Ban sync initiated by ${interaction.user.tag} in ${interaction.guild?.name}`);
    
    const stats: SyncStats = {
      totalBans: 0,
      newBans: 0,
      alreadyBanned: 0,
      errors: 0,
      details: new Map(),
    };
    
    // Collect all bans from all servers
    const allBans = new Map<string, { userId: string; userTag: string; sourceServerId: string; sourceServerName: string; reason: string }>();
    
    for (const configServer of serversConfig.servers) {
      const guild = client.guilds.cache.get(configServer.id);
      if (!guild) continue;
      
      try {
        const bans = await guild.bans.fetch();
        console.log(`📋 Found ${bans.size} bans in ${configServer.name}`);
        
        for (const [userId, ban] of bans) {
          // Skip bans that were already synced
          if (ban.reason?.startsWith('[BanSync]')) continue;
          
          // Only add if we haven't seen this user yet, or if this ban has a better reason
          if (!allBans.has(userId) || !allBans.get(userId)!.reason) {
            allBans.set(userId, {
              userId: ban.user.id,
              userTag: ban.user.tag,
              sourceServerId: guild.id,
              sourceServerName: configServer.name,
              reason: ban.reason || 'No reason provided',
            });
          }
        }
      } catch (error) {
        console.error(`❌ Failed to fetch bans from ${configServer.name}:`, error);
      }
    }
    
    console.log(`\n📊 Total unique bans to sync: ${allBans.size}`);
    
    if (allBans.size === 0) {
      await interaction.editReply({
        content: '✅ No bans found to sync across servers.',
      });
      return;
    }
    
    // Send initial progress message
    await interaction.editReply({
      content: `🔄 Syncing ${allBans.size} bans across ${serversConfig.servers.length} servers...\nThis may take a moment.`,
    });
    
    // Sync each ban to all servers
    let processedCount = 0;
    for (const [userId, banInfo] of allBans) {
      processedCount++;
      const results = await syncBanToAllServers(banInfo);
      
      stats.totalBans++;
      stats.details.set(userId, { user: banInfo.userTag, results });
      
      for (const result of results) {
        if (result.success && !result.alreadyBanned) {
          stats.newBans++;
        } else if (result.alreadyBanned) {
          stats.alreadyBanned++;
        } else if (!result.success && result.error) {
          stats.errors++;
        }
      }
      
      // Update progress every 5 bans
      if (processedCount % 5 === 0) {
        await interaction.editReply({
          content: `🔄 Syncing bans: ${processedCount}/${allBans.size} processed...`,
        });
      }
      
      // Add delay between processing different users to prevent rate limiting
      await new Promise(resolve => setTimeout(resolve, BAN_DELAY_MS));
    }
    
    // Create summary embed
    const embed = new EmbedBuilder()
      .setTitle('🔄 Ban Sync Complete')
      .setDescription(`Synchronized ${stats.totalBans} unique bans across ${serversConfig.servers.length} servers.`)
      .addFields(
        { name: '✅ New Bans Applied', value: stats.newBans.toString(), inline: true },
        { name: '🔄 Already Banned', value: stats.alreadyBanned.toString(), inline: true },
        { name: '❌ Errors', value: stats.errors.toString(), inline: true },
        { name: 'Requested By', value: `${interaction.user.tag} (<@${interaction.user.id}>)`, inline: false }
      )
      .setColor(stats.errors > 0 ? Colors.Orange : Colors.Green)
      .setTimestamp()
      .setFooter({ text: `Requested by ${interaction.user.tag}` });
    
    await interaction.editReply({
      content: null,
      embeds: [embed],
    });
    
    // Send log to all configured logging channels
    await sendLogToAll(embed);
    
    console.log(`\n✅ Sync complete:`);
    console.log(`   Total bans: ${stats.totalBans}`);
    console.log(`   New bans: ${stats.newBans}`);
    console.log(`   Already banned: ${stats.alreadyBanned}`);
    console.log(`   Errors: ${stats.errors}`);
    
  } catch (error) {
    console.error('❌ Error during sync:', error);
    await interaction.editReply({
      content: '❌ An error occurred during the sync process. Check the logs for details.',
    });
  }
}

async function syncBanToAllServers(banInfo: { 
  userId: string; 
  userTag: string; 
  sourceServerId: string; 
  sourceServerName: string; 
  reason: string; 
}): Promise<BanResult[]> {
  const results: BanResult[] = [];
  
  for (const configServer of serversConfig.servers) {
    const guild = client.guilds.cache.get(configServer.id);
    
    if (!guild) {
      results.push({
        serverId: configServer.id,
        serverName: configServer.name,
        success: false,
        alreadyBanned: false,
        error: 'Bot not in server',
      });
      continue;
    }
    
    try {
      // Check if bot has ban permissions
      const botMember = await guild.members.fetch(client.user!.id);
      if (!botMember.permissions.has(PermissionFlagsBits.BanMembers)) {
        results.push({
          serverId: configServer.id,
          serverName: configServer.name,
          success: false,
          alreadyBanned: false,
          error: 'Missing Permissions',
        });
        console.log(`  ❌ Missing ban permission in ${configServer.name}`);
        continue;
      }
      
      // Check if already banned
      const existingBan = await guild.bans.fetch(banInfo.userId).catch(() => null);
      
      if (existingBan) {
        results.push({
          serverId: configServer.id,
          serverName: configServer.name,
          success: true,
          alreadyBanned: true,
        });
        continue;
      }
      
      // Check if this ban is currently being processed to prevent loops
      if (isBanProcessing(banInfo.userId, guild.id)) {
        results.push({
          serverId: configServer.id,
          serverName: configServer.name,
          success: true,
          alreadyBanned: true, // Treat as already handled
        });
        console.log(`  ⏭️  Skipping ${configServer.name} (already processing)`);
        continue;
      }
      
      // Mark as processing
      markBanProcessing(banInfo.userId, guild.id);
      
      // Ban the user
      const syncReason = `[BanSync] Originally banned in ${banInfo.sourceServerName} | Reason: ${banInfo.reason}`;
      await guild.members.ban(banInfo.userId, {
        reason: syncReason,
        deleteMessageSeconds: 0, // Don't delete messages during sync
      });
      
      results.push({
        serverId: configServer.id,
        serverName: configServer.name,
        success: true,
        alreadyBanned: false,
      });
      
      console.log(`  ✅ Banned ${banInfo.userTag} in ${configServer.name}`);
      
      // Add delay between bans to prevent rate limiting and allow events to process
      await new Promise(resolve => setTimeout(resolve, BAN_DELAY_MS));
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      results.push({
        serverId: configServer.id,
        serverName: configServer.name,
        success: false,
        alreadyBanned: false,
        error: errorMessage,
      });
      
      // Unmark if failed
      unmarkBanProcessing(banInfo.userId, guild.id);
    }
  }
  
  return results;
}

client.on('guildBanAdd', async (ban) => {
  const bannedUser = ban.user;
  const sourceGuild = ban.guild;

  // Only process if this is one of our configured servers
  if (!serverMap.has(sourceGuild.id)) {
    console.log(`⚠️  Ban detected in non-configured server: ${sourceGuild.name} (${sourceGuild.id})`);
    return;
  }

  const sourceServer = serverMap.get(sourceGuild.id)!;
  
  // Check if this ban is currently being processed (to prevent loops)
  if (isBanProcessing(bannedUser.id, sourceGuild.id)) {
    console.log(`⚠️  Skipping BanSync ban to prevent loop: ${bannedUser.tag} in ${sourceServer.name}`);
    return;
  }
  
  // Fetch the ban to get the reason
  let banReason = 'No reason provided';
  try {
    const fetchedBan = await sourceGuild.bans.fetch(bannedUser.id);
    banReason = fetchedBan.reason || 'No reason provided';
  } catch (error) {
    console.log(`⚠️  Could not fetch ban reason: ${error}`);
  }
  
  // Skip if this is a BanSync ban to prevent loops (secondary check)
  if (banReason.startsWith('[BanSync]')) {
    console.log(`⚠️  Skipping BanSync ban to prevent loop: ${bannedUser.tag}`);
    return;
  }
  
  console.log(`\n🔨 Ban detected: ${bannedUser.tag} (${bannedUser.id}) in ${sourceServer.name}`);
  console.log(`   Reason: ${banReason}`);

  const results: BanResult[] = [];

  // Process all configured servers
  for (const configServer of serversConfig.servers) {
    const guild = client.guilds.cache.get(configServer.id);
    
    if (!guild) {
      // Bot not in this guild
      results.push({
        serverId: configServer.id,
        serverName: configServer.name,
        success: false,
        alreadyBanned: false,
        error: 'Bot not in server',
      });
      continue;
    }

    if (configServer.id === sourceGuild.id) {
      // Source guild where the ban originated
      results.push({
        serverId: configServer.id,
        serverName: configServer.name,
        success: true,
        alreadyBanned: false,
      });
      continue;
    }

    try {
      // Check if bot has ban permissions
      const botMember = await guild.members.fetch(client.user!.id);
      if (!botMember.permissions.has(PermissionFlagsBits.BanMembers)) {
        results.push({
          serverId: configServer.id,
          serverName: configServer.name,
          success: false,
          alreadyBanned: false,
          error: 'Missing Permissions',
        });
        console.log(`  ❌ Missing ban permission in ${configServer.name}`);
        continue;
      }
      
      // Check if already banned
      const existingBan = await guild.bans.fetch(bannedUser.id).catch(() => null);
      
      if (existingBan) {
        results.push({
          serverId: configServer.id,
          serverName: configServer.name,
          success: true,
          alreadyBanned: true,
        });
        continue;
      }

      // Check if this ban is currently being processed to prevent loops
      if (isBanProcessing(bannedUser.id, guild.id)) {
        results.push({
          serverId: configServer.id,
          serverName: configServer.name,
          success: true,
          alreadyBanned: true, // Treat as already handled
        });
        console.log(`  ⏭️  Skipping ${configServer.name} (already processing)`);
        continue;
      }

      // Mark as processing before banning
      markBanProcessing(bannedUser.id, guild.id);

      // Ban the user with [BanSync] prefix
      const syncReason = `[BanSync] Banned in ${sourceServer.name} | Reason: ${banReason}`;
      await guild.members.ban(bannedUser.id, {
        reason: syncReason,
      });

      results.push({
        serverId: configServer.id,
        serverName: configServer.name,
        success: true,
        alreadyBanned: false,
      });

      console.log(`  ✅ Banned in ${configServer.name}`);
      
      // Add delay between bans to prevent rate limiting and allow events to process
      await new Promise(resolve => setTimeout(resolve, BAN_DELAY_MS));
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      results.push({
        serverId: configServer.id,
        serverName: configServer.name,
        success: false,
        alreadyBanned: false,
        error: errorMessage,
      });
      console.log(`  ❌ Failed to ban in ${configServer.name}: ${errorMessage}`);
      
      // Unmark if failed
      unmarkBanProcessing(bannedUser.id, guild.id);
    }
  }

  // Create formatted output
  console.log(`\n📋 Ban Sync Results for ${bannedUser.tag}:`);
  
  const successCount = results.filter(r => r.success && !r.alreadyBanned).length;
  const failureCount = results.filter(r => !r.success).length;
  const alreadyBannedCount = results.filter(r => r.alreadyBanned).length;
  
  if (failureCount === 0) {
    // Simplified output when everything succeeded
    console.log(`  ✅ Synced to ${successCount} server${successCount !== 1 ? 's' : ''}`);
    if (alreadyBannedCount > 0) {
      console.log(`  🔄 Already banned in ${alreadyBannedCount} server${alreadyBannedCount !== 1 ? 's' : ''}`);
    }
  } else {
    // Detailed output when there were failures
    for (const result of results) {
      const emoji = result.success ? '✔️' : '❌';
      const status = result.alreadyBanned ? ' (already banned)' : result.error ? ` (${result.error})` : '';
      console.log(`  ${result.serverName}: ${emoji}${status}`);
    }
  }

  // Send ban report to all logging channels
  await sendBanReportToAll(sourceServer.name, bannedUser, results, banReason);
});

async function sendBanReportToAll(
  sourceServerName: string,
  bannedUser: { tag: string; id: string },
  results: BanResult[],
  banReason: string
) {
  const successCount = results.filter(r => r.success && !r.alreadyBanned).length;
  const failureCount = results.filter(r => !r.success).length;
  const alreadyBannedCount = results.filter(r => r.alreadyBanned).length;

  const embed = new EmbedBuilder()
    .setTitle('🔨 Ban Sync Report')
    .setColor(Colors.Red)
    .setTimestamp();

  // If all servers succeeded (no failures), show simplified message
  if (failureCount === 0) {
    embed.setDescription(`User **${bannedUser.tag}** has been banned across all servers.`)
      .addFields(
        { name: 'User', value: `<@${bannedUser.id}> (\`${bannedUser.id}\`)`, inline: false },
        { name: 'Banned In', value: sourceServerName, inline: false },
        { name: 'Reason', value: banReason, inline: false },
        {
          name: 'Summary',
          value: `✅ Synced to ${successCount} server${successCount !== 1 ? 's' : ''}\n🔄 Already banned in ${alreadyBannedCount} server${alreadyBannedCount !== 1 ? 's' : ''}`,
          inline: false,
        }
      );
  } else {
    // Show detailed results if there were any failures
    const resultText = results
      .map(r => {
        const emoji = r.success ? '✔️' : '❌';
        const status = r.alreadyBanned ? ' (already banned)' : r.error ? ` (${r.error})` : '';
        return `${r.serverName}: ${emoji}${status}`;
      })
      .join('\n');

    embed.setDescription(`User **${bannedUser.tag}** ban sync completed with some issues.`)
      .addFields(
        { name: 'User', value: `<@${bannedUser.id}> (\`${bannedUser.id}\`)`, inline: false },
        { name: 'Banned In', value: sourceServerName, inline: false },
        { name: 'Reason', value: banReason, inline: false },
        { name: 'Servers', value: resultText || 'None', inline: false },
        {
          name: 'Summary',
          value: `✅ Synced: ${successCount}\n❌ Failed: ${failureCount}\n🔄 Already banned: ${alreadyBannedCount}`,
          inline: false,
        }
      );
  }

  // Send to all configured logging channels
  await sendLogToAll(embed);
}

// Error handling
client.on('error', (error) => {
  console.error('Client error:', error);
});

process.on('unhandledRejection', (error) => {
  console.error('Unhandled promise rejection:', error);
});

// Login
client.login(TOKEN);