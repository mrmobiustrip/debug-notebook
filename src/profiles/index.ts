import type * as vscode from 'vscode';
import { GenericProfile } from './GenericProfile';
import type { LanguageProfile } from './LanguageProfile';

export class ProfileRegistry {
  private readonly profiles: LanguageProfile[] = [];
  private readonly fallback = new GenericProfile();

  register(profile: LanguageProfile): void {
    this.profiles.push(profile);
  }

  for(session: vscode.DebugSession): LanguageProfile {
    return this.profiles.find((p) => p.matches(session)) ?? this.fallback;
  }
}
