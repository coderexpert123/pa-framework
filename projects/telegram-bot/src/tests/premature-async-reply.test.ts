import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isPrematureAsyncReply } from '../logic.js';

describe('isPrematureAsyncReply (AI-202)', () => {
  it('1. exact incident string is caught', () => {
    assert.equal(
      isPrematureAsyncReply('I have launched the git log check and will review the output once it completes.'),
      true
    );
  });

  it('2. false-positive anchor is NOT caught (~300 chars + list item veto)', () => {
    const text = 'I have launched the topic status card refresh and am waiting for it to finish updating the pinned cards across Telegram topics.\nAll changes have been executed and verified:\n\n1. **Global Worker Configuration** updated across all targets.\n2. **Topic cards** refreshed in all active topics.\n3. Complete.';
    assert.equal(isPrematureAsyncReply(text), false);
  });

  it('3. promise + task id is caught', () => {
    assert.equal(
      isPrematureAsyncReply('Kicked off task-72 and will report back when it lands.'),
      true
    );
  });

  it('4. promise + path is NOT caught (deliverable veto)', () => {
    assert.equal(
      isPrematureAsyncReply('Launched the build. Log at C:/x/y.log and will wait.'),
      false
    );
    assert.equal(
      isPrematureAsyncReply('Launched the build. Log at C:\\x\\y.log and will wait.'),
      false
    );
  });

  it('5. promise + URL is NOT caught (deliverable veto)', () => {
    assert.equal(
      isPrematureAsyncReply('Launched the deploy at https://example.com/build and will wait for it to complete.'),
      false
    );
  });

  it('6. promise + heading or list is NOT caught (deliverable veto)', () => {
    assert.equal(
      isPrematureAsyncReply('Launched the check and waiting for it.\n# Result\nPending.'),
      false
    );
    assert.equal(
      isPrematureAsyncReply('Launched the scan and will wait.\n- item 1'),
      false
    );
    assert.equal(
      isPrematureAsyncReply('Launched the scan and will wait.\n```\noutput\n```'),
      false
    );
  });

  it('7. empty string, whitespace, undefined-safe', () => {
    assert.equal(isPrematureAsyncReply(''), false);
    assert.equal(isPrematureAsyncReply('   \n\t  '), false);
    assert.equal(isPrematureAsyncReply(undefined as unknown as string), false);
    assert.equal(isPrematureAsyncReply(null as unknown as string), false);
  });

  it('8. >240 chars is NOT caught even when it matches every pattern', () => {
    const longText = 'I have launched the process and am waiting for it to finish. '.repeat(5);
    assert.ok(longText.length > 240);
    assert.equal(isPrematureAsyncReply(longText), false);
  });

  it('9. plain short answer with no promise verb is NOT caught', () => {
    assert.equal(isPrematureAsyncReply('Done. 42 rows updated.'), false);
  });

  it('10. plain short answer that mentions waiting but launched nothing is NOT caught', () => {
    assert.equal(
      isPrematureAsyncReply('Nothing to do, so I am waiting on your input.'),
      false
    );
  });

  it('11. ref ID in text is NOT caught (deliverable veto)', () => {
    assert.equal(
      isPrematureAsyncReply('Dispatched the job and will wait for it. Ref s-123456789012'),
      false
    );
  });
});
