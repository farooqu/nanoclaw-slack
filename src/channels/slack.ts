import { App, LogLevel } from '@slack/bolt';
import type { GenericMessageEvent, BotMessageEvent } from '@slack/types';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { updateChatName } from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

// Slack's chat.postMessage API limits text to ~4000 characters per call.
// Messages exceeding this are split into sequential chunks.
const MAX_MESSAGE_LENGTH = 4000;

// The message subtypes we process. Bolt delivers all subtypes via app.event('message');
// we filter to regular messages (GenericMessageEvent, subtype undefined) and bot messages
// (BotMessageEvent, subtype 'bot_message') so we can track our own output.
type HandledMessageEvent = GenericMessageEvent | BotMessageEvent;

export interface SlackChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class SlackChannel implements Channel {
  name = 'slack';

  private app: App;
  private botUserId: string | undefined;
  private connected = false;
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;
  private userNameCache = new Map<string, string>();
  // 'channelId:threadTs' entries blocked from threading (via /no-thread prefix)
  private noThreadSet = new Set<string>();

  private opts: SlackChannelOpts;

  constructor(opts: SlackChannelOpts) {
    this.opts = opts;

    // Read tokens from .env (not process.env — keeps secrets off the environment
    // so they don't leak to child processes, matching NanoClaw's security pattern)
    const env = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
    const botToken = env.SLACK_BOT_TOKEN;
    const appToken = env.SLACK_APP_TOKEN;

    if (!botToken || !appToken) {
      throw new Error(
        'SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be set in .env',
      );
    }

    this.app = new App({
      token: botToken,
      appToken,
      socketMode: true,
      logLevel: LogLevel.ERROR,
    });

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    // Use app.event('message') instead of app.message() to capture all
    // message subtypes including bot_message (needed to track our own output)
    this.app.event('message', async ({ event }) => {
      // Bolt's event type is the full MessageEvent union (17+ subtypes).
      // We filter on subtype first, then narrow to the two types we handle.
      const subtype = (event as { subtype?: string }).subtype;
      if (subtype && subtype !== 'bot_message') return;

      // After filtering, event is either GenericMessageEvent or BotMessageEvent
      const msg = event as HandledMessageEvent;

      if (!msg.text) return;

      const isBotMessage = !!msg.bot_id || msg.user === this.botUserId;

      const channelId = msg.channel;
      const channelJid = `slack:${channelId}`;
      const msgTs = msg.ts;
      const msgThreadTs = (msg as { thread_ts?: string }).thread_ts;
      const isThreadReply = !!msgThreadTs && msgThreadTs !== msgTs;
      const timestamp = new Date(parseFloat(msgTs) * 1000).toISOString();
      const isGroup = msg.channel_type !== 'im';

      // Always report channel metadata for group discovery
      this.opts.onChatMetadata(channelJid, timestamp, undefined, 'slack', isGroup);

      const groups = this.opts.registeredGroups();

      // Determine the effective JID and thread routing
      let jid: string;
      let content = msg.text;

      if (isThreadReply) {
        // Thread reply: use thread JID unless this thread_ts is blocked (/no-thread)
        const blocked = this.noThreadSet.has(`${channelId}:${msgThreadTs}`);
        jid = blocked ? channelJid : `${channelJid}:thread:${msgThreadTs}`;
      } else {
        // Root channel message: default to threading unless /no-thread prefix
        if (!isBotMessage && content.trimStart().startsWith('/no-thread')) {
          // Opt out: respond in channel, block this thread_ts for all future replies
          this.noThreadSet.add(`${channelId}:${msgTs}`);
          content = content.replace(/^\/no-thread\s*/i, '').trim();
          jid = channelJid;
        } else {
          // Default: route to thread JID — bot's first reply will create the thread
          jid = `${channelJid}:thread:${msgTs}`;
        }
      }

      // For thread JIDs: only deliver if the parent channel is registered.
      // For channel JIDs: only deliver if the channel itself is registered.
      const parentJid = jid.includes(':thread:') ? channelJid : jid;
      if (!groups[parentJid]) return;

      // Auto-register thread group on first message.
      // Thread groups share the parent's folder (same CLAUDE.md, tools, mounts)
      // but get a unique sessionKey so index.ts gives each thread its own Claude session.
      if (jid !== channelJid && !groups[jid]) {
        const { threadTs: tTs } = this.parseSlackJid(jid);
        if (tTs) {
          const parentGroup = groups[channelJid];
          const sessionKey = this.getThreadSessionKey(parentGroup.folder, tTs);
          // Mutate the live registeredGroups reference — visible to index.ts immediately.
          // folder stays as parentGroup.folder so the container uses the parent's
          // CLAUDE.md, tools, and mounts; sessionKey is unique per thread.
          groups[jid] = { ...parentGroup, sessionKey, requiresTrigger: false };
          logger.info(
            { jid, sessionKey, parentFolder: parentGroup.folder },
            'Slack thread group registered',
          );
        }
      }

      // Report thread JID metadata so message storage can find the chat entry
      if (jid !== channelJid) {
        this.opts.onChatMetadata(jid, timestamp, undefined, 'slack', isGroup);
      }

      let senderName: string;
      if (isBotMessage) {
        senderName = ASSISTANT_NAME;
      } else {
        senderName =
          (msg.user ? await this.resolveUserName(msg.user) : undefined) ||
          msg.user ||
          'unknown';
      }

      // Translate Slack <@UBOTID> mentions into TRIGGER_PATTERN format.
      // Slack encodes @mentions as <@U12345>, which won't match TRIGGER_PATTERN
      // (e.g., ^@<ASSISTANT_NAME>\b), so we prepend the trigger when the bot is @mentioned.
      if (this.botUserId && !isBotMessage) {
        const mentionPattern = `<@${this.botUserId}>`;
        if (content.includes(mentionPattern) && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      this.opts.onMessage(jid, {
        id: msgTs,
        chat_jid: jid,
        sender: msg.user || msg.bot_id || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: isBotMessage,
        is_bot_message: isBotMessage,
      });
    });
  }

  async connect(): Promise<void> {
    await this.app.start();

    // Get bot's own user ID for self-message detection.
    // Resolve this BEFORE setting connected=true so that messages arriving
    // during startup can correctly detect bot-sent messages.
    try {
      const auth = await this.app.client.auth.test();
      this.botUserId = auth.user_id as string;
      logger.info({ botUserId: this.botUserId }, 'Connected to Slack');
    } catch (err) {
      logger.warn(
        { err },
        'Connected to Slack but failed to get bot user ID',
      );
    }

    this.connected = true;

    // Flush any messages queued before connection
    await this.flushOutgoingQueue();

    // Sync channel names on startup
    await this.syncChannelMetadata();
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const { channelId, threadTs } = this.parseSlackJid(jid);

    if (!this.connected) {
      this.outgoingQueue.push({ jid, text });
      logger.info(
        { jid, queueSize: this.outgoingQueue.length },
        'Slack disconnected, message queued',
      );
      return;
    }

    try {
      // Slack limits messages to ~4000 characters; split if needed
      if (text.length <= MAX_MESSAGE_LENGTH) {
        await this.app.client.chat.postMessage({
          channel: channelId,
          text,
          ...(threadTs ? { thread_ts: threadTs } : {}),
        });
      } else {
        for (let i = 0; i < text.length; i += MAX_MESSAGE_LENGTH) {
          await this.app.client.chat.postMessage({
            channel: channelId,
            text: text.slice(i, i + MAX_MESSAGE_LENGTH),
            ...(threadTs ? { thread_ts: threadTs } : {}),
          });
        }
      }
      logger.info({ jid, length: text.length }, 'Slack message sent');
    } catch (err) {
      this.outgoingQueue.push({ jid, text });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send Slack message, queued',
      );
    }
  }

  /**
   * Parse a Slack JID into its channel ID and optional thread timestamp.
   * Handles both channel JIDs (slack:CHANNEL) and thread JIDs (slack:CHANNEL:thread:THREAD_TS).
   */
  private parseSlackJid(jid: string): { channelId: string; threadTs?: string } {
    const sep = ':thread:';
    const idx = jid.indexOf(sep);
    if (idx !== -1) {
      return {
        channelId: jid.slice('slack:'.length, idx),
        threadTs: jid.slice(idx + sep.length),
      };
    }
    return { channelId: jid.slice('slack:'.length) };
  }

  /**
   * Derive a unique session key for a Slack thread.
   * Format: {parentFolder}_t_{sanitized_thread_ts}, max 64 chars.
   * Used as the session key (not the folder) so each thread gets an isolated
   * Claude session while still running against the parent group's folder.
   */
  private getThreadSessionKey(parentFolder: string, threadTs: string): string {
    const sanitized = threadTs.replace(/\./g, '_');
    return `${parentFolder}_t_${sanitized}`.slice(0, 64);
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('slack:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    await this.app.stop();
  }

  // Slack does not expose a typing indicator API for bots.
  // This no-op satisfies the Channel interface so the orchestrator
  // doesn't need channel-specific branching.
  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // no-op: Slack Bot API has no typing indicator endpoint
  }

  /**
   * Sync channel metadata from Slack.
   * Fetches channels the bot is a member of and stores their names in the DB.
   */
  async syncChannelMetadata(): Promise<void> {
    try {
      logger.info('Syncing channel metadata from Slack...');
      let cursor: string | undefined;
      let count = 0;

      do {
        const result = await this.app.client.conversations.list({
          types: 'public_channel,private_channel',
          exclude_archived: true,
          limit: 200,
          cursor,
        });

        for (const ch of result.channels || []) {
          if (ch.id && ch.name && ch.is_member) {
            updateChatName(`slack:${ch.id}`, ch.name);
            count++;
          }
        }

        cursor = result.response_metadata?.next_cursor || undefined;
      } while (cursor);

      logger.info({ count }, 'Slack channel metadata synced');
    } catch (err) {
      logger.error({ err }, 'Failed to sync Slack channel metadata');
    }
  }

  private async resolveUserName(
    userId: string,
  ): Promise<string | undefined> {
    if (!userId) return undefined;

    const cached = this.userNameCache.get(userId);
    if (cached) return cached;

    try {
      const result = await this.app.client.users.info({ user: userId });
      const name = result.user?.real_name || result.user?.name;
      if (name) this.userNameCache.set(userId, name);
      return name;
    } catch (err) {
      logger.debug({ userId, err }, 'Failed to resolve Slack user name');
      return undefined;
    }
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info(
        { count: this.outgoingQueue.length },
        'Flushing Slack outgoing queue',
      );
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        const { channelId, threadTs } = this.parseSlackJid(item.jid);
        await this.app.client.chat.postMessage({
          channel: channelId,
          text: item.text,
          ...(threadTs ? { thread_ts: threadTs } : {}),
        });
        logger.info(
          { jid: item.jid, length: item.text.length },
          'Queued Slack message sent',
        );
      }
    } finally {
      this.flushing = false;
    }
  }
}

registerChannel('slack', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
  if (!envVars.SLACK_BOT_TOKEN || !envVars.SLACK_APP_TOKEN) {
    logger.warn('Slack: SLACK_BOT_TOKEN or SLACK_APP_TOKEN not set');
    return null;
  }
  return new SlackChannel(opts);
});
