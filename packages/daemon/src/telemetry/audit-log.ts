export interface AuditEntry {
  timestamp: string;
  actor: 'user' | 'system';
  action: string;
  target: string;
  detail?: string;
}

export class AuditLog {
  private entries: AuditEntry[] = [];

  record(entry: Omit<AuditEntry, 'timestamp'>): AuditEntry {
    const full: AuditEntry = {
      timestamp: new Date().toISOString(),
      ...entry,
    };
    this.entries.push(full);
    return full;
  }

  query(opts?: { from?: string; to?: string }): AuditEntry[] {
    let results = this.entries;
    if (opts?.from) {
      results = results.filter((e) => e.timestamp >= opts.from!);
    }
    if (opts?.to) {
      results = results.filter((e) => e.timestamp <= opts.to!);
    }
    return results;
  }
}
