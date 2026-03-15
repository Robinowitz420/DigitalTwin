import { readFile } from 'node:fs/promises'
import * as path from 'node:path'
import Papa from 'papaparse'
import type {
  RedditComment,
  RedditDataset,
  RedditImportProgress,
  RedditPost,
  RedditSaved,
  RedditSubscription,
  RedditUpvoted,
} from '../types/reddit.types.js'

type CsvRow = Record<string, string>

async function readCsv(filePath: string): Promise<CsvRow[]> {
  const raw = await readFile(filePath, 'utf8')
  const parsed = Papa.parse<CsvRow>(raw, {
    header: true,
    skipEmptyLines: true,
  })

  if (parsed.errors.length > 0) {
    const fatal = parsed.errors.find((e) => e.code !== 'UndetectableDelimiter')
    if (fatal) {
      throw new Error(`CSV parse error in ${path.basename(filePath)}: ${fatal.message}`)
    }
  }

  return parsed.data
}

function pick(row: CsvRow, keys: string[]): string | undefined {
  for (const k of keys) {
    if (row[k] != null && String(row[k]).trim() !== '') return row[k]
  }
  return undefined
}

function normalizeSubreddit(value?: string): string | null {
  if (!value) return null
  const v = value.trim()
  if (v === '') return null
  return v.replace(/^r\//i, '')
}

function normalizeDate(value?: string): string | null {
  if (!value) return null
  const v = value.trim()
  if (v === '') return null

  const asNumber = Number(v)
  if (!Number.isNaN(asNumber) && Number.isFinite(asNumber)) {
    const ms = asNumber < 10_000_000_000 ? asNumber * 1000 : asNumber
    return new Date(ms).toISOString()
  }

  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString()
}

function normalizePermalink(value?: string): string | null {
  if (!value) return null
  const v = value.trim()
  if (v === '') return null
  return v
}

function normalizeId(row: CsvRow, fallbackPrefix: string, idx: number): string {
  return (
    pick(row, ['id', 'comment_id', 'post_id', 'thing_id', 'full_id']) ??
    `${fallbackPrefix}-${idx}`
  )
}

export async function parseRedditExportFolder(
  folderPath: string,
  onProgress?: (p: RedditImportProgress) => void,
): Promise<RedditDataset> {
  const commentsPath = path.join(folderPath, 'comments.csv')
  const postsPath = path.join(folderPath, 'posts.csv')
  const commentVotesPath = path.join(folderPath, 'comment_votes.csv')
  const postVotesPath = path.join(folderPath, 'post_votes.csv')
  const upvotedPath = path.join(folderPath, 'upvoted.csv')

  const savedCommentsPath = path.join(folderPath, 'saved_comments.csv')
  const savedPostsPath = path.join(folderPath, 'saved_posts.csv')
  const savedPath = path.join(folderPath, 'saved.csv')

  const subredditsPath = path.join(folderPath, 'subreddits.csv')
  const subscribedSubredditsPath = path.join(folderPath, 'subscribed_subreddits.csv')

  onProgress?.({ stage: 'parsing', percent: 15, message: 'Parsing comments.csv' })
  const commentRows = await safeReadCsv(commentsPath)

  onProgress?.({ stage: 'parsing', percent: 30, message: 'Parsing posts.csv' })
  const postRows = await safeReadCsv(postsPath)

  onProgress?.({ stage: 'parsing', percent: 45, message: 'Parsing votes/upvotes' })
  const upvotedRows = await safeReadCsv(upvotedPath)
  const commentVoteRows = await safeReadCsv(commentVotesPath)
  const postVoteRows = await safeReadCsv(postVotesPath)

  onProgress?.({ stage: 'parsing', percent: 60, message: 'Parsing saved' })
  const savedRows = await safeReadCsv(savedPath)
  const savedCommentRows = await safeReadCsv(savedCommentsPath)
  const savedPostRows = await safeReadCsv(savedPostsPath)

  onProgress?.({ stage: 'parsing', percent: 75, message: 'Parsing subreddits' })
  const subredditRows = await safeReadCsv(subredditsPath)
  const subscribedRows = await safeReadCsv(subscribedSubredditsPath)

  const comments: RedditComment[] = commentRows.map((r, idx) => ({
    id: normalizeId(r, 'comment', idx),
    subreddit: normalizeSubreddit(pick(r, ['subreddit', 'community'])),
    permalink: normalizePermalink(pick(r, ['permalink', 'link', 'url'])),
    body: pick(r, ['body', 'comment', 'text']) ?? '',
    createdAt: normalizeDate(pick(r, ['created_at', 'created', 'timestamp', 'date'])),
    score: parseOptionalNumber(pick(r, ['score', 'ups', 'upvotes'])),
  }))

  const posts: RedditPost[] = postRows.map((r, idx) => ({
    id: normalizeId(r, 'post', idx),
    subreddit: normalizeSubreddit(pick(r, ['subreddit', 'community'])),
    permalink: normalizePermalink(pick(r, ['permalink', 'link', 'url'])),
    title: pick(r, ['title', 'subject']) ?? '',
    body: pick(r, ['body', 'selftext', 'text']),
    createdAt: normalizeDate(pick(r, ['created_at', 'created', 'timestamp', 'date'])),
    score: parseOptionalNumber(pick(r, ['score', 'ups', 'upvotes'])),
  }))

  const legacyUpvoted: RedditUpvoted[] = upvotedRows.map((r, idx) => ({
    id: normalizeId(r, 'upvoted', idx),
    subreddit: normalizeSubreddit(pick(r, ['subreddit', 'community'])),
    permalink: normalizePermalink(pick(r, ['permalink', 'link', 'url'])),
    title: pick(r, ['title', 'subject']),
    createdAt: normalizeDate(pick(r, ['created_at', 'created', 'timestamp', 'date'])),
  }))

  const voteRows = [...commentVoteRows, ...postVoteRows]
  const voteUpvoted: RedditUpvoted[] = voteRows
    .filter((r) => {
      const direction = pick(r, ['direction', 'vote', 'vote_direction', 'voteDirection'])
      const dirNum = direction != null ? Number(direction) : NaN
      if (!Number.isNaN(dirNum)) return dirNum === 1

      const d = (direction ?? '').toLowerCase().trim()
      return d === '1' || d === 'up' || d === 'upvote' || d === 'upvoted'
    })
    .map((r, idx) => ({
      id: normalizeId(r, 'upvoted', idx),
      subreddit: normalizeSubreddit(pick(r, ['subreddit', 'community', 'subreddit_name'])),
      permalink: normalizePermalink(pick(r, ['permalink', 'link', 'url'])),
      title: pick(r, ['title', 'subject', 'link_title']),
      createdAt: normalizeDate(pick(r, ['created_at', 'created', 'timestamp', 'date', 'vote_date'])),
    }))

  const upvoted: RedditUpvoted[] = [...voteUpvoted, ...legacyUpvoted]

  const legacySaved: RedditSaved[] = savedRows.map((r, idx) => ({
    id: normalizeId(r, 'saved', idx),
    subreddit: normalizeSubreddit(pick(r, ['subreddit', 'community'])),
    permalink: normalizePermalink(pick(r, ['permalink', 'link', 'url'])),
    title: pick(r, ['title', 'subject']),
    createdAt: normalizeDate(pick(r, ['created_at', 'created', 'timestamp', 'date'])),
  }))

  const savedFromSplit = [...savedCommentRows, ...savedPostRows].map((r, idx) => ({
    id: normalizeId(r, 'saved', idx),
    subreddit: normalizeSubreddit(pick(r, ['subreddit', 'community', 'subreddit_name'])),
    permalink: normalizePermalink(pick(r, ['permalink', 'link', 'url'])),
    title: pick(r, ['title', 'subject', 'link_title']),
    createdAt: normalizeDate(pick(r, ['created_at', 'created', 'timestamp', 'date'])),
  }))

  const saved: RedditSaved[] = [...savedFromSplit, ...legacySaved]

  const subreddits: RedditSubscription[] = [...subredditRows, ...subscribedRows]
    .map((r) => normalizeSubreddit(pick(r, ['name', 'subreddit', 'community', 'subreddit_name'])))
    .filter((v): v is string => v != null)
    .map((name) => ({ name }))

  return {
    source: 'reddit',
    importedAt: new Date().toISOString(),
    comments,
    posts,
    saved,
    upvoted,
    subreddits,
  }
}

async function safeReadCsv(filePath: string): Promise<CsvRow[]> {
  try {
    return await readCsv(filePath)
  } catch (e) {
    if (e instanceof Error && e.message.includes('ENOENT')) {
      return []
    }
    throw e
  }
}

function parseOptionalNumber(value?: string): number | null {
  if (!value) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}
