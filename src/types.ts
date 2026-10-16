// Implements Design: shared pipeline and extraction types.

export type FieldStatus<T> =
  | { status: 'ok'; value: T }
  | { status: 'unsicher'; reason: string };

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
  rewards: FieldStatus<Reward[]>;
  description: FieldStatus<string>;
}

export interface SeasonalExtractResult extends ExtractResult {
  periods: FieldStatus<SeasonalPeriod[]>;
  eventState: FieldStatus<SeasonalEventState>;
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
  description?: string;
  fields?: DiscordEmbedField[];
  footer?: { text: string };
}

export interface DiscordMessagePayload {
  content?: string;
  embeds?: DiscordEmbed[];
}

export interface DiscordMessageSnapshot extends DiscordMessagePayload {
  id: string;
  channelId: string;
  authorIsBot: boolean;
  pinned: boolean;
  content: string;
  embeds: DiscordEmbed[];
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

export interface DiscordPort {
  createMessage(channelId: string, payload: DiscordMessagePayload): Promise<DiscordMessageSnapshot>;
  editMessage(channelId: string, messageId: string, payload: DiscordMessagePayload): Promise<DiscordMessageSnapshot>;
  fetchRecentBotMessages(channelId: string, limit: number): Promise<DiscordMessageSnapshot[]>;
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
