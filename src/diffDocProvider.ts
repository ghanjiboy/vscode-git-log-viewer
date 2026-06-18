import * as vscode from 'vscode';
import { GitService } from './gitService';

interface DiffDocParams {
    repoRoot: string;
    sha: string;
    filePath: string;
}

export class DiffDocProvider implements vscode.TextDocumentContentProvider {
    static readonly scheme = 'git-log-viewer';

    constructor(private gitService: GitService) {}

    static encodeUri(repoRoot: string, sha: string, filePath: string): vscode.Uri {
        const params: DiffDocParams = { repoRoot, sha, filePath };
        const encoded = Buffer.from(JSON.stringify(params)).toString('base64');
        return vscode.Uri.parse(`${DiffDocProvider.scheme}:${filePath}?${encoded}`);
    }

    static decodeUri(uri: vscode.Uri): DiffDocParams {
        return JSON.parse(Buffer.from(uri.query, 'base64').toString('utf-8'));
    }

    async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
        if (!uri.query) {
            return '';
        }
        const params = DiffDocProvider.decodeUri(uri);
        return this.gitService.getFileAtRevision(params.repoRoot, params.sha, params.filePath);
    }
}
