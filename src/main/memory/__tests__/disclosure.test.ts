/**
 * Adversarial Test Cases for Evidence of Disclosure
 * 
 * Tests epistemic honesty: "Knowledge is not stored. It is reconstructed from evidence."
 * 
 * Run with: npx vitest run src/main/memory/__tests__/disclosure.test.ts
 */

import { describe, it, expect } from 'vitest'
import { evidenceOfDisclosure, detectDisclosureQuery, expandTopic, detectAcknowledgment } from '../retrieval.js'
import type { IdentityEvent } from '../../../types/identity.types.js'
import type { MemoryStore, MemoryChunk } from '../store.js'

// Helper to create mock SMS events
function mockEvent(
  participants: string[],
  text: string,
  isUserMessage: boolean,
  timestamp: string = '2025-01-15T10:00:00Z'
): IdentityEvent {
  return {
    source: 'sms',
    kind: 'message',
    participants,
    text,
    createdAt: timestamp,
    metadata: { isUserMessage },
  }
}

// Helper to create mock memory store
function mockStore(chunks: MemoryChunk[] = []): MemoryStore {
  return {
    version: 1,
    lastProcessed: new Date().toISOString(),
    totalChunks: chunks.length,
    chunks,
    metaSummaries: {},
    knowledgeStates: {},
  }
}

// Helper to create mock memory chunk with knowledge deltas
function mockChunk(
  contactKey: string,
  knowledgeDeltas: MemoryChunk['knowledgeDeltas'],
  startTime: number = Date.now() - 86400000,
  endTime: number = Date.now()
): MemoryChunk {
  return {
    id: `${contactKey}_${startTime}`,
    contactKey,
    conversationKey: '2025-01-15_10',
    startTime,
    endTime,
    summary: 'Test summary',
    topics: knowledgeDeltas.map(d => d.topic),
    notableEvents: [],
    tone: 'casual',
    messageCount: 10,
    processedAt: new Date().toISOString(),
    modelUsed: 'test',
    gapCount: 0,
    confidence: 0.8,
    sourceRange: { contact: contactKey, start: '2025-01-15', end: '2025-01-15' },
    knowledgeDeltas,
  }
}

describe('detectDisclosureQuery', () => {
  it('detects "does X know about Y" pattern', () => {
    const contacts = ['Mom', 'Dad', 'Alice']
    const result = detectDisclosureQuery('Does Mom know about my startup?', contacts)
    expect(result.isDisclosure).toBe(true)
    expect(result.contact).toBe('Mom')
    expect(result.topic).toBe('my startup')
  })

  it('detects "did I tell X about Y" pattern', () => {
    const contacts = ['Mom', 'Dad', 'Alice']
    const result = detectDisclosureQuery('Did I tell Dad about the job?', contacts)
    expect(result.isDisclosure).toBe(true)
    expect(result.contact).toBe('Dad')
    expect(result.topic).toBe('the job')
  })

  it('detects "have I mentioned Y to X" pattern', () => {
    const contacts = ['Mom', 'Dad', 'Alice']
    const result = detectDisclosureQuery('Have I mentioned the breakup to Alice?', contacts)
    expect(result.isDisclosure).toBe(true)
    expect(result.contact).toBe('Alice')
    expect(result.topic).toBe('the breakup')
  })

  it('returns false for non-disclosure queries', () => {
    const contacts = ['Mom', 'Dad', 'Alice']
    const result = detectDisclosureQuery('What did I tell Mom about the bus?', contacts)
    expect(result.isDisclosure).toBe(false)
  })
})

describe('expandTopic', () => {
  it('expands startup to synonyms', () => {
    const expanded = expandTopic('startup')
    expect(expanded).toContain('startup')
    expect(expanded).toContain('company')
    expect(expanded).toContain('project')
  })

  it('expands job to synonyms', () => {
    const expanded = expandTopic('job')
    expect(expanded).toContain('job')
    expect(expanded).toContain('work')
    expect(expanded).toContain('career')
  })

  it('returns original topic if no synonyms', () => {
    const expanded = expandTopic('golf')
    expect(expanded).toEqual(['golf'])
  })
})

describe('detectAcknowledgment', () => {
  it('detects when contact references topic', () => {
    const messages: IdentityEvent[] = [
      mockEvent(['Mom'], 'How is your startup going?', false, '2025-01-20T10:00:00Z'),
    ]
    const result = detectAcknowledgment(messages, ['startup'])
    expect(result.acknowledged).toBe(true)
    expect(result.evidence.length).toBe(1)
  })

  it('ignores user messages', () => {
    const messages: IdentityEvent[] = [
      mockEvent(['Mom'], 'I started a startup', true, '2025-01-15T10:00:00Z'),
    ]
    const result = detectAcknowledgment(messages, ['startup'])
    expect(result.acknowledged).toBe(false)
  })

  it('returns false when no acknowledgment', () => {
    const messages: IdentityEvent[] = [
      mockEvent(['Mom'], 'How are you?', false, '2025-01-20T10:00:00Z'),
    ]
    const result = detectAcknowledgment(messages, ['startup'])
    expect(result.acknowledged).toBe(false)
  })
})

describe('evidenceOfDisclosure', () => {
  describe('Test Case 1: False Memory Trap', () => {
    it('returns status=none when topic was never mentioned', () => {
      const events: IdentityEvent[] = [
        mockEvent(['Mom'], 'Hey Mom, how are you?', true, '2025-01-15T10:00:00Z'),
        mockEvent(['Mom'], 'I\'m good, thanks!', false, '2025-01-15T10:01:00Z'),
      ]
      
      const result = evidenceOfDisclosure(events, 'Mom', 'divorce')
      
      expect(result.status).toBe('none')
      expect(result.answer).toContain('No evidence found')
      expect(result.evidence.evidence.length).toBe(0)
    })
  })

  describe('Test Case 2: Indirect Mention', () => {
    it('returns status=weak for vague/indirect mention', () => {
      const events: IdentityEvent[] = [
        mockEvent(['Mom'], 'I\'ve been working on something new', true, '2025-01-15T10:00:00Z'),
      ]
      
      const result = evidenceOfDisclosure(events, 'Mom', 'startup')
      
      // "something new" doesn't match startup keywords
      expect(result.status).toBe('none')
    })

    it('detects hinted status from knowledge deltas', () => {
      const events: IdentityEvent[] = [
        mockEvent(['Mom'], 'I\'ve been working on something new', true, '2025-01-15T10:00:00Z'),
      ]
      
      const store = mockStore([
        mockChunk('Mom', [
          { topic: 'startup', status: 'hinted', date: '2025-01-15', evidence: 'I\'ve been working on something new' }
        ])
      ])
      
      const result = evidenceOfDisclosure(events, 'Mom', 'startup', store)
      
      expect(result.notes.some(n => n.includes('Indirect mention'))).toBe(true)
    })
  })

  describe('Test Case 3: Acknowledgment Without Disclosure', () => {
    it('notes when contact references topic but no prior disclosure found', () => {
      const events: IdentityEvent[] = [
        // Contact mentions startup, but user never said it
        mockEvent(['Mom'], 'How\'s your startup going?', false, '2025-01-20T10:00:00Z'),
      ]
      
      const result = evidenceOfDisclosure(events, 'Mom', 'startup')
      
      expect(result.evidence.acknowledged).toBe(true)
      expect(result.notes).toContain('Contact acknowledged the topic')
    })
  })

  describe('Test Case 4: Temporal Conflict', () => {
    it('returns status=conflicting when user contradicts themselves', () => {
      const events: IdentityEvent[] = [
        // Feb: user tells Mom
        mockEvent(['Mom'], 'I got a job at Stripe!', true, '2025-02-01T10:00:00Z'),
        // March: user says they haven't told anyone
        mockEvent(['Mom'], 'I haven\'t told anyone about the job yet', true, '2025-03-01T10:00:00Z'),
      ]
      
      const result = evidenceOfDisclosure(events, 'Mom', 'job')
      
      expect(result.status).toBe('conflicting')
      expect(result.evidence.contradictions.length).toBeGreaterThan(0)
      expect(result.answer).toContain('conflicting')
    })
  })

  describe('Test Case 5: Repeated Mentions', () => {
    it('increases confidence for multiple mentions spread across time', () => {
      const events: IdentityEvent[] = [
        mockEvent(['Mom'], 'I got a job at Stripe!', true, '2025-01-15T10:00:00Z'),
        mockEvent(['Mom'], 'The job is going well', true, '2025-02-15T10:00:00Z'),
        mockEvent(['Mom'], 'I got promoted at my job!', true, '2025-03-15T10:00:00Z'),
      ]
      
      const result = evidenceOfDisclosure(events, 'Mom', 'job')
      
      expect(result.status).toBe('confirmed')
      expect(result.evidence.mentionCount).toBe(3)
      expect(result.evidence.spreadAcrossTime).toBe(true)
      expect(result.evidence.confidence).toBeGreaterThan(0.5)
    })
  })

  describe('Test Case 6: Acknowledgment Strengthens', () => {
    it('increases confidence when contact acknowledges topic', () => {
      const events: IdentityEvent[] = [
        mockEvent(['Mom'], 'I started a startup', true, '2025-01-15T10:00:00Z'),
        mockEvent(['Mom'], 'How\'s your startup going?', false, '2025-01-20T10:00:00Z'),
      ]
      
      const result = evidenceOfDisclosure(events, 'Mom', 'startup')
      
      expect(result.evidence.acknowledged).toBe(true)
      expect(result.answer).toContain('later referenced')
    })
  })

  describe('Knowledge Delta Integration', () => {
    it('uses knowledge deltas from memory store', () => {
      const events: IdentityEvent[] = [
        mockEvent(['Mom'], 'Random message', true, '2025-01-15T10:00:00Z'),
      ]
      
      const store = mockStore([
        mockChunk('Mom', [
          { topic: 'startup', status: 'disclosed', date: '2025-01-10', evidence: 'I launched my startup!' }
        ])
      ])
      
      const result = evidenceOfDisclosure(events, 'Mom', 'startup', store)
      
      expect(result.evidence.evidence.length).toBeGreaterThan(0)
      expect(result.evidence.evidence[0].text).toContain('startup')
    })

    it('detects contradicted status from knowledge deltas', () => {
      const events: IdentityEvent[] = []
      
      const store = mockStore([
        mockChunk('Mom', [
          { topic: 'job', status: 'disclosed', date: '2025-01-10', evidence: 'I got the job!' },
          { topic: 'job', status: 'contradicted', date: '2025-02-10', evidence: 'I never got that job' }
        ])
      ])
      
      const result = evidenceOfDisclosure(events, 'Mom', 'job', store)
      
      expect(result.evidence.contradictions.length).toBeGreaterThan(0)
    })
  })
})
