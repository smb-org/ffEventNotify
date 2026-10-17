// Implements Design: shared pipeline and extraction types.

export type FieldStatus<T> =
  | { status: 'ok'; value: T }
  | { status: 'unsicher'; reason: string };

export interface NotApplicable {
  status: 'n/a';
}

export type PeriodEvidence = 'yes' | 'no' | 'unsicher';

export type EventType = 'seasonal-special' | 'maintenance' | 'topic-generic';

export interface Period {
  startUtc: string;
  endUtc: string;
}

export interface Reward {
  itemId: string;
  name: string;
  section: string;
  /** Verbatim cost label from the special page, when the page provides one. */
  cost?: string;
}

export interface ResolvedItem {
  itemId: string;
  name: string;
  iconUrl: string;
}

export interface SeasonalPeriod {
  startUtc: string;
  endUtc: string | null;
}

export type SeasonalEventState = 'active' | 'upcoming' | 'ended' | 'not-an-event' | 'ambiguous';

export interface ExtractResult {
  title: FieldStatus<string>;
  period: FieldStatus<Period>;
  rewards: FieldStatus<Reward[]> | NotApplicable;
  description: FieldStatus<string>;
}

export interface SeasonalExtractResult extends ExtractResult {
  periods: FieldStatus<SeasonalPeriod[]>;
  eventState: FieldStatus<SeasonalEventState>;
  imageUrl?: string;
}

export interface GenericExtractResult extends ExtractResult {
  date: FieldStatus<string>;
}

export type ListSource = 'topic' | 'maintenance' | 'feed' | 'banner';

export type EventSourceKind = ListSource | 'special' | 'followup';

export interface ListEntry {
  title: string;
  url: string;
  source: ListSource;
  publishedAt?: string;
  publishedEpoch?: number;
}

export type FetchPriority = 'list' | 'detail' | 'item' | 'wiki';

export interface FetchTextResult {
  status: number;
  body: string;
  finalUrl: string;
}

export type FetchText = (url: string, options: { priority: FetchPriority }) => Promise<FetchTextResult>;

export interface ParsedListEntry {
  title: string;
  url: string;
  publishedEpoch?: number;
}

export interface ParsedMaintenanceEntry extends ParsedListEntry {
  tag: string;
}

export interface NewsFeedEntry {
  title: string;
  url: string;
  published: string;
  category: string;
}

export interface WikiEvent {
  name: string;
  startUtc?: string;
  endUtc?: string;
  unparsedReason?: string;
}

export interface DiscordEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface DiscordEmbed {
  title?: string;
  url?: string;
  description?: string;
  color?: number;
  author?: { name: string };
  image?: { url: string };
  fields?: DiscordEmbedField[];
  footer?: { text: string };
}

export interface DiscordButtonComponent {
  type: 'button';
  style: 'primary' | 'secondary' | 'link';
  label: string;
  customId?: string;
  url?: string;
  disabled?: boolean;
}

export interface DiscordStringSelectOption {
  label: string;
  value: string;
  description?: string;
  default?: boolean;
}

export interface DiscordStringSelectComponent {
  type: 'string-select';
  customId: string;
  placeholder?: string;
  minValues: number;
  maxValues: number;
  options: DiscordStringSelectOption[];
}

export interface DiscordActionRow {
  components: Array<DiscordButtonComponent | DiscordStringSelectComponent>;
}

export interface DiscordAllowedMentions {
  parse: [];
  users: string[];
}

export interface DiscordMessagePayload {
  content?: string;
  embeds?: DiscordEmbed[];
  components?: DiscordActionRow[];
  allowedMentions?: DiscordAllowedMentions;
  suppressEmbeds?: boolean;
}

export interface DiscordMessageSnapshot extends DiscordMessagePayload {
  id: string;
  channelId: string;
  createdAt?: string;
  authorIsBot: boolean;
  pinned: boolean;
  content: string;
  embeds: DiscordEmbed[];
  components?: DiscordActionRow[];
}

export interface DiscordMessageHistory {
  messages: DiscordMessageSnapshot[];
  complete: boolean;
}

export interface DiscordMessageHistoryOptions {
  olderThan?: string;
  requireChannelStart?: boolean;
}

export type ScheduledEventStatus = 'SCHEDULED' | 'ACTIVE' | 'COMPLETED' | 'CANCELED' | 'UNKNOWN';

export interface ScheduledEventPayload {
  name: string;
  startUtc: string;
  endUtc: string;
  location: string;
  description: string;
}

export interface ScheduledEventSnapshot extends ScheduledEventPayload {
  id: string;
  guildId: string;
  status: ScheduledEventStatus;
}

export interface DiscordThreadSnapshot {
  id: string;
  parentChannelId: string;
  starterMessageId: string | null;
  name: string;
  archived: boolean;
}

export interface DiscordForumTag {
  id: string;
  name: string;
  moderated?: boolean;
  emoji?: { id: string | null; name: string | null } | null;
}

export interface DiscordForumPostSnapshot extends DiscordThreadSnapshot {
  appliedTags: string[];
  starterMessage: DiscordMessageSnapshot;
  autoArchiveDuration: number;
  archiveTimestamp?: string | null;
  lastMessageAt?: string | null;
  locked: boolean;
  pinned: boolean;
}

export interface DiscordForumTagData {
  id?: string;
  name: string;
  moderated?: boolean;
  emoji?: { id: string | null; name: string | null } | null;
}

export interface DiscordPort {
  createMessage(channelId: string, payload: DiscordMessagePayload): Promise<DiscordMessageSnapshot>;
  editMessage(channelId: string, messageId: string, payload: DiscordMessagePayload): Promise<DiscordMessageSnapshot>;
  fetchRecentBotMessages(channelId: string, limit: number, options?: DiscordMessageHistoryOptions): Promise<DiscordMessageHistory>;
  fetchPinnedBotMessages(channelId: string): Promise<DiscordMessageSnapshot[]>;
  fetchMessage(channelId: string, messageId: string): Promise<DiscordMessageSnapshot | null>;
  isTextChannel(channelId: string): Promise<boolean>;
  /** Forum methods are optional for older in-memory adapters; the live DiscordJsPort implements all of them. */
  isForumChannel?(channelId: string): Promise<boolean>;
  fetchForumTags?(channelId: string): Promise<DiscordForumTag[]>;
  setForumTags?(channelId: string, tags: readonly DiscordForumTagData[]): Promise<DiscordForumTag[]>;
  createForumPost?(channelId: string, name: string, payload: DiscordMessagePayload, appliedTags: readonly string[], autoArchiveDuration: number): Promise<DiscordForumPostSnapshot>;
  fetchForumPost?(channelId: string, threadId: string): Promise<DiscordForumPostSnapshot | null>;
  listForumPosts?(channelId: string): Promise<DiscordForumPostSnapshot[]>;
  editForumStarter?(threadId: string, payload: DiscordMessagePayload): Promise<DiscordMessageSnapshot>;
  setForumPostTags?(threadId: string, appliedTags: readonly string[]): Promise<void>;
  setForumPostName?(threadId: string, name: string): Promise<void>;
  setForumPostArchived?(threadId: string, archived: boolean): Promise<void>;
  setForumPostAutoArchiveDuration?(threadId: string, autoArchiveDuration: number): Promise<void>;
  refreshForumPostKeepAlive?(threadId: string, autoArchiveDuration: number): Promise<void>;
  keepForumPostActive?(threadId: string, autoArchiveDuration: number): Promise<void>;
  pinForumPost?(threadId: string): Promise<void>;
  addThreadMember?(threadId: string, userId: string): Promise<void>;
  removeThreadMember?(threadId: string, userId: string): Promise<void>;
  startThreadOnMessage(channelId: string, starterMessageId: string, name: string, autoArchiveDuration: number): Promise<DiscordThreadSnapshot>;
  fetchThread(channelId: string, threadId: string | null, starterMessageId: string | null): Promise<DiscordThreadSnapshot | null>;
  sendToThread(threadId: string, payload: DiscordMessagePayload): Promise<DiscordMessageSnapshot>;
  deleteThreadMessage?(threadId: string, messageId: string): Promise<void>;
  createScheduledEvent(guildId: string, payload: ScheduledEventPayload): Promise<ScheduledEventSnapshot>;
  editScheduledEvent(guildId: string, eventId: string, payload: ScheduledEventPayload): Promise<ScheduledEventSnapshot>;
  listScheduledEvents(guildId: string): Promise<ScheduledEventSnapshot[]>;
  pinMessage(channelId: string, messageId: string): Promise<void>;
  sendLog(channelId: string, content: string): Promise<void>;
}

export interface KnownEventTitle {
  title: string;
  startUtc?: string;
  endUtc?: string;
}

export type Classification =
  | { status: 'classified'; eventType: EventType; eventKey?: string }
  | { status: 'ignored'; reason: string }
  | { status: 'unclassified'; reason: string };
