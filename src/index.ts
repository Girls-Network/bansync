import { Client, GatewayIntentBits, Guild, EmbedBuilder, Colors } from 'discord.js';
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

interface ServerConfig {
  id: string;
  name: string;
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

// Load server configuration
let serversConfig: ServersConfig;
try {
  const configPath = join(process.cwd(), 'servers.json');
  const configFile = readFileSync(configPath, 'utf-8');
  serversConfig = JSON.parse(configFile);
  
  if (!serversConfig.servers || !Array.isArray(serversConfig.servers)) {
    throw new Error('Invalid servers.json format');
  }
} catch (error) {
  console.error('❌ Error loading servers.json:', error);
  console.error('Please ensure servers.json exists and is properly formatted.');
  process.exit(1);
}

// Create a map for quick lookup
const serverMap = new Map<string, string>(
  serversConfig.servers.map(s => [s.id, s.name])
);

client.once('ready', () => {
  console.log(`✅ Logged in as ${client.user?.tag}`);
  console.log(`📊 Configured servers:`);
  
  for (const server of serversConfig.servers) {
    const guild = client.guilds.cache.get(server.id);
    if (guild) {
      console.log(`  ✔️  ${server.name} (${server.id})`);
    } else {
      console.log(`  ❌ ${server.name} (${server.id}) - Bot not in this server!`);
    }
  }
});

client.on('guildBanAdd', async (ban) => {
  const bannedUser = ban.user;
  const sourceGuild = ban.guild;

  // Only process if this is one of our configured servers
  if (!serverMap.has(sourceGuild.id)) {
    console.log(`⚠️  Ban detected in non-configured server: ${sourceGuild.name} (${sourceGuild.id})`);
    return;
  }

  const sourceServerName = serverMap.get(sourceGuild.id)!;
  console.log(`\n🔨 Ban detected: ${bannedUser.tag} (${bannedUser.id}) in ${sourceServerName}`);

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
      // Check if user is in the guild
      const member = await guild.members.fetch(bannedUser.id).catch(() => null);
      
      if (!member) {
        // User not in this guild
        results.push({
          serverId: configServer.id,
          serverName: configServer.name,
          success: false,
          alreadyBanned: false,
        });
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

      // Ban the user
      await guild.members.ban(bannedUser.id, {
        reason: `Ban sync from ${sourceServerName}`,
      });

      results.push({
        serverId: configServer.id,
        serverName: configServer.name,
        success: true,
        alreadyBanned: false,
      });

      console.log(`  ✅ Banned in ${configServer.name}`);
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
    }
  }

  // Create formatted output
  console.log(`\n📋 Ban Sync Results for ${bannedUser.tag}:`);
  for (const result of results) {
    const emoji = result.success ? '✔️' : '❌';
    const status = result.alreadyBanned ? ' (already banned)' : '';
    console.log(`  ${result.serverName}: ${emoji}${status}`);
  }

  // Try to send a message to the source guild's system channel
  await sendBanReport(sourceGuild, bannedUser, results);
});

async function sendBanReport(
  sourceGuild: Guild,
  bannedUser: { tag: string; id: string },
  results: BanResult[]
) {
  try {
    const systemChannel = sourceGuild.systemChannel;
    
    if (!systemChannel || !systemChannel.permissionsFor(client.user!)?.has('SendMessages')) {
      return; // No system channel or no permission
    }

    const successCount = results.filter(r => r.success && !r.alreadyBanned).length;
    const failureCount = results.filter(r => !r.success).length;
    const alreadyBannedCount = results.filter(r => r.alreadyBanned).length;

    // Format results
    const resultText = results
      .map(r => {
        const emoji = r.success ? '✔️' : '❌';
        const status = r.alreadyBanned ? ' (already banned)' : r.error ? ` (${r.error})` : '';
        return `${r.serverName}: ${emoji}${status}`;
      })
      .join('\n');

    const embed = new EmbedBuilder()
      .setTitle('🔨 Ban Sync Report')
      .setDescription(`User **${bannedUser.tag}** has been banned across servers.`)
      .addFields(
        { name: 'User', value: `<@${bannedUser.id}> (\`${bannedUser.id}\`)`, inline: false },
        { name: 'Servers', value: resultText || 'None', inline: false },
        {
          name: 'Summary',
          value: `✅ Banned: ${successCount}\n❌ Not in server: ${failureCount}\n🔄 Already banned: ${alreadyBannedCount}`,
          inline: false,
        }
      )
      .setColor(Colors.Red)
      .setTimestamp();

    await systemChannel.send({ embeds: [embed] });
  } catch (error) {
    console.error('Failed to send ban report:', error);
  }
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