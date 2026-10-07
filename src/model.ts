export type Membership = 'included' | 'excluded' | 'missing' | 'unknown';
export type MembershipValidity = 'verified_packlist' | 'uncovered' | 'stale' | 'error';
export type ExplanationStatus = 'confirmed' | 'ambiguous' | 'unknown' | 'conflict' | 'not_applicable';
export interface Limits { maxNodes: number; maxDepth: number; maxRuleBytes: number; maxTotalRuleBytes: number; timeoutMs: number }
export interface Diagnostic { code: string; severity: 'info' | 'warning' | 'error'; scope: string; message: string; relativePath?: string; actionableNextStep?: string; cleanupId?: string }
export interface SourceLocation { line: number; column: number; jsonPointer?: string }
export interface RuleSource { sourceId: string; kind: 'files' | 'npmignore' | 'gitignore' | 'builtin' | 'manifest'; path: string; text?: string; line?: number; column?: number; jsonPointer?: string; virtualRevision?: number; active?: boolean; inactiveReason?: string; builtinId?: string; officialSource?: string; generatedPatterns?: string[]; zeroMatch?: boolean }
export interface FileEntry { path: string; kind: 'file' | 'directory' | 'link' | 'special' | 'collapsed'; exists: boolean; rawBytes: string; membership: Membership; membershipValidity: MembershipValidity; explanationStatus: ExplanationStatus; evidenceIds: string[] }
export interface Snapshot { snapshotId: string; baseSnapshotId?: string; revision?: number; manifestVirtualRevision?: number; appliedPatch?: Patch; projectLabel: string; capturedAt: string; complete: boolean; limits: Limits; entries: FileEntry[]; ruleSources: RuleSource[]; manifest: Record<string, unknown>; manifestText: string; manifestLocations: Record<string, SourceLocation>; uncoveredInputs: string[]; diagnostics: Diagnostic[] }
export interface RuntimeProfile { profileId: string; nodeVersion: string; versions: Record<string, string>; cliVersions: Record<string, string>; sourceHashes: Record<string, string>; adapterVersion: string; supportedFeatures: string[]; lifecycleScripts: false; globalConfigApplied: false; standalone: true; matched: boolean }
export interface Evidence { evidenceId: string; path: string; evaluationOrder: number; ruleId: string; candidateSources: string[]; pattern: string; matched: boolean; before: boolean; after: boolean; changed: boolean; ancestorChain: string[]; sourceMapping: 'exact' | 'ambiguous' | 'unknown'; basis: string; decision: 'match' | 'ancestor_block' | 'forced_include'; mode?: number; matchCalls?: { input: string; partial: boolean; result: boolean }[] }
export type PatchOperation =
  | { op:'replaceFiles'; value:string[]; expected?:string[] | null }
  | { op:'removeIgnoreLine'; path:string; line:number; expected:string }
  | { op:'replaceIgnoreLine'; path:string; line:number; expected:string; value:string }
  | { op:'appendIgnoreLine'; path:string; value:string }
  | { op:'replaceIgnoreText'; path:string; value:string; expected?:string }
  | { op:'createIgnore'; path:string; value:string }
  | { op:'deleteIgnore'; path:string; expected?:string };
export interface Patch { schemaVersion:1; baseSnapshotId?:string; expectedRevision?:number; operations:PatchOperation[] }
export interface Intent { schemaVersion:1; mustShip?:string[]; mustNotShip?:string[]; sizeBudget?:{ maxRawBytes:string; include?:string[] } }
export interface AssertionResult { assertionId: string; type: 'mustShip' | 'mustNotShip' | 'sizeBudget'; selector: string | string[]; matchedExistingPaths: string[]; matchedShippedPaths: string[]; status: 'pass' | 'fail' | 'unknown'; reasonCodes: string[]; bytesActual?: string; bytesLimit?: string }
export interface Delta { addedPaths: string[]; removedPaths: string[]; addedRawBytes: string; removedRawBytes: string; retainedContentByteChanges: { path: string; beforeRawBytes: string; afterRawBytes: string; deltaRawBytes: string }[]; netRawBytes: string }
export interface Scenario { scenarioId: string; baseSnapshotId: string; revision: number; patch?: Patch; oracleFiles: string[]; tracedFiles: string[]; reconciliation: { status: 'equal' | 'conflict' | 'unavailable'; missing: string[]; extra: string[] }; aggregate: { rawBytes: string; fileCount: number }; assertions: AssertionResult[]; delta?: Delta }
export interface PackReport { schemaVersion: 1; profile: RuntimeProfile; snapshot: Snapshot; entries: FileEntry[]; evidence: Evidence[]; ruleSources: RuleSource[]; diagnostics: Diagnostic[]; scenario: Scenario; complete: boolean }
