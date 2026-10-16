// Implements Design: ephemeral reward checklist interaction.

export interface ChecklistSelection {
  eventId: string;
  userId: string;
  itemIds: readonly string[];
}

export function saveChecklistSelection(selection: ChecklistSelection): Promise<void> {
  void selection;
  throw new Error('not implemented');
}
