import { execFile } from 'child_process';
import { Commit, CommitDetail, FileChange, BlameLineData } from './types';

const RECORD_SEP = '\x1e';
const MAX_BUFFER = 10 * 1024 * 1024;

function exec(args: string[], cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile('git', args, { cwd, maxBuffer: MAX_BUFFER }, (err, stdout, stderr) => {
            if (err) {
                reject(new Error(stderr || err.message));
            } else {
                resolve(stdout);
            }
        });
    });
}

export class GitService {
    async getRepoRoot(fsPath: string): Promise<string> {
        const out = await exec(['rev-parse', '--show-toplevel'], fsPath);
        return out.trim();
    }

    async getLog(repoRoot: string, targetPath: string, skip: number, count: number): Promise<Commit[]> {
        const format = `%H${RECORD_SEP}%h${RECORD_SEP}%s${RECORD_SEP}%an${RECORD_SEP}%aI`;
        const args = ['log', `--format=${format}`, `--skip=${skip}`, `-${count}`, '--', targetPath];
        const out = await exec(args, repoRoot);
        if (!out.trim()) {
            return [];
        }
        return out.trim().split('\n').map(line => {
            const parts = line.split(RECORD_SEP);
            return {
                hash: parts[0],
                shortHash: parts[1],
                subject: parts[2],
                authorName: parts[3],
                authorDate: parts[4],
            };
        });
    }

    async getCommitDetail(repoRoot: string, sha: string): Promise<CommitDetail> {
        const format = `%H${RECORD_SEP}%h${RECORD_SEP}%an${RECORD_SEP}%ae${RECORD_SEP}%aI${RECORD_SEP}%B`;
        const args = ['show', '--no-patch', `--format=${format}`, sha];
        const out = await exec(args, repoRoot);
        const parts: string[] = [];
        let remaining = out;
        for (let i = 0; i < 5; i++) {
            const idx = remaining.indexOf(RECORD_SEP);
            parts.push(remaining.substring(0, idx));
            remaining = remaining.substring(idx + 1);
        }
        parts.push(remaining.trim());
        return {
            hash: parts[0],
            shortHash: parts[1],
            authorName: parts[2],
            authorEmail: parts[3],
            authorDate: parts[4],
            body: parts[5],
        };
    }

    async getCommitFiles(repoRoot: string, sha: string): Promise<FileChange[]> {
        const [statusOut, numstatOut] = await Promise.all([
            exec(['diff-tree', '--root', '--no-commit-id', '-r', '--name-status', sha], repoRoot),
            exec(['diff-tree', '--root', '--no-commit-id', '-r', '--numstat', sha], repoRoot),
        ]);

        const statusMap = new Map<string, { status: string; oldPath?: string }>();
        for (const line of statusOut.trim().split('\n')) {
            if (!line) continue;
            const parts = line.split('\t');
            const statusCode = parts[0];
            if (statusCode.startsWith('R') || statusCode.startsWith('C')) {
                statusMap.set(parts[2], { status: statusCode[0], oldPath: parts[1] });
            } else {
                statusMap.set(parts[1], { status: statusCode });
            }
        }

        const files: FileChange[] = [];
        for (const line of numstatOut.trim().split('\n')) {
            if (!line) continue;
            const parts = line.split('\t');
            const additions = parts[0] === '-' ? 0 : parseInt(parts[0], 10);
            const deletions = parts[1] === '-' ? 0 : parseInt(parts[1], 10);
            const filePath = parts.length === 3 ? parts[2] : parts[3];
            const info = statusMap.get(filePath) || { status: 'M' };
            files.push({
                path: filePath,
                oldPath: info.oldPath,
                status: info.status,
                additions,
                deletions,
            });
        }
        return files;
    }

    async getFileAtRevision(repoRoot: string, sha: string, filePath: string): Promise<string> {
        try {
            return await exec(['show', `${sha}:${filePath}`], repoRoot);
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            if (msg.includes('does not exist') || msg.includes('bad revision')) {
                return '';
            }
            throw e;
        }
    }

    async getDiffBetween(repoRoot: string, sha1: string, sha2: string): Promise<FileChange[]> {
        const [statusOut, numstatOut] = await Promise.all([
            exec(['diff', '--name-status', sha1, sha2, '--'], repoRoot),
            exec(['diff', '--numstat', sha1, sha2, '--'], repoRoot),
        ]);

        const statusMap = new Map<string, { status: string; oldPath?: string }>();
        for (const line of statusOut.trim().split('\n')) {
            if (!line) continue;
            const parts = line.split('\t');
            const statusCode = parts[0];
            if (statusCode.startsWith('R') || statusCode.startsWith('C')) {
                statusMap.set(parts[2], { status: statusCode[0], oldPath: parts[1] });
            } else {
                statusMap.set(parts[1], { status: statusCode });
            }
        }

        const files: FileChange[] = [];
        for (const line of numstatOut.trim().split('\n')) {
            if (!line) continue;
            const parts = line.split('\t');
            const additions = parts[0] === '-' ? 0 : parseInt(parts[0], 10);
            const deletions = parts[1] === '-' ? 0 : parseInt(parts[1], 10);
            const filePath = parts.length === 3 ? parts[2] : parts[3];
            const info = statusMap.get(filePath) || { status: 'M' };
            files.push({
                path: filePath,
                oldPath: info.oldPath,
                status: info.status,
                additions,
                deletions,
            });
        }
        return files;
    }

    async blameRaw(repoRoot: string, sha: string, filePath: string): Promise<string> {
        return exec(['blame', '--porcelain', sha, '--', filePath], repoRoot);
    }

    async blameStructured(repoRoot: string, sha: string, filePath: string): Promise<BlameLineData[]> {
        const output = await this.blameRaw(repoRoot, sha, filePath);
        const lines = output.split('\n');
        const results: BlameLineData[] = [];
        let currentSha = '';
        let currentAuthor = '';
        let currentAuthorEmail = '';
        let currentTimestamp = 0;
        let currentDate = '';
        let currentSummary = '';
        let currentLineNo = 0;

        for (const line of lines) {
            if (/^[0-9a-f]{40} /.test(line)) {
                const parts = line.split(' ');
                currentSha = parts[0];
                currentLineNo = parseInt(parts[2], 10);
            } else if (line.startsWith('author ')) {
                currentAuthor = line.substring(7);
            } else if (line.startsWith('author-mail ')) {
                currentAuthorEmail = line.substring(12).replace(/[<>]/g, '');
            } else if (line.startsWith('author-time ')) {
                currentTimestamp = parseInt(line.substring(12), 10);
                currentDate = new Date(currentTimestamp * 1000).toLocaleString();
            } else if (line.startsWith('summary ')) {
                currentSummary = line.substring(8);
            } else if (line.startsWith('\t')) {
                results.push({
                    sha: currentSha,
                    shortSha: currentSha.substring(0, 8),
                    author: currentAuthor,
                    authorEmail: currentAuthorEmail,
                    timestamp: currentTimestamp,
                    date: currentDate,
                    summary: currentSummary,
                    lineNo: currentLineNo,
                    content: line.substring(1),
                });
            }
        }
        return results;
    }
}
