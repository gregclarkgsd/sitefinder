export const MAX_GMAIL_HISTORY_PAGES = 10;

function decimalHistoryId(value) {
  const historyId = String(value || '').trim();
  if (!/^\d+$/.test(historyId)) return '';
  return historyId.replace(/^0+(?=\d)/, '');
}

export function buildGmailHistoryPath(startHistoryId, pageToken = '') {
  const historyId = decimalHistoryId(startHistoryId);
  if (!historyId) throw new Error('A valid Gmail history cursor is required');
  const params = new URLSearchParams({
    startHistoryId: historyId,
    maxResults: '500',
  });
  params.append('historyTypes', 'messageAdded');
  if (pageToken) params.set('pageToken', String(pageToken));
  return `/history?${params.toString()}`;
}

export function mergeHistoryMessageIds(existingIds, page) {
  const merged = [...existingIds];
  const seen = new Set(merged);
  for (const historyItem of page?.history || []) {
    for (const added of historyItem?.messagesAdded || []) {
      const messageId = String(added?.message?.id || '').trim();
      if (!messageId || seen.has(messageId)) continue;
      seen.add(messageId);
      merged.push(messageId);
    }
  }
  return merged;
}

export function nextHistoryPageToken(
  page,
  pagesFetched,
  maxPages = MAX_GMAIL_HISTORY_PAGES,
) {
  const nextPageToken = String(page?.nextPageToken || '').trim();
  if (nextPageToken && pagesFetched >= maxPages) {
    throw new Error(`Gmail history exceeded the safe ${maxPages}-page limit`);
  }
  return nextPageToken;
}

export function latestHistoryCursor(...values) {
  const historyIds = values.map(decimalHistoryId).filter(Boolean);
  if (!historyIds.length) throw new Error('Gmail did not return a valid history cursor');
  return historyIds.reduce((latest, candidate) => {
    if (candidate.length !== latest.length) {
      return candidate.length > latest.length ? candidate : latest;
    }
    return candidate > latest ? candidate : latest;
  });
}

export function watchRenewalUpdate(watchResponse, updatedAt) {
  const expiration = Number(watchResponse?.expiration);
  if (!Number.isFinite(expiration) || expiration <= Date.parse(updatedAt)) {
    throw new Error('Gmail watch response did not include a valid future expiration');
  }
  return {
    watch_expiration: new Date(expiration).toISOString(),
    last_error: null,
    updated_at: updatedAt,
  };
}

export function initialWatchState(watchResponse, updatedAt) {
  return {
    ...watchRenewalUpdate(watchResponse, updatedAt),
    gmail_history_id: latestHistoryCursor(watchResponse?.historyId),
  };
}

export function inboundLeadStatus(currentStatus, detectedStatus) {
  return currentStatus === 'suppressed' ? 'suppressed' : detectedStatus;
}

export function classifyFollowupResponse(httpStatus, responseOk, body) {
  const emailSent = body?.email_sent === true
    ? true
    : body?.email_sent === false
      ? false
      : null;
  const reconciliationRequired = body?.reconciliation_required === true;
  const retrySafe = body?.retry_safe === true;
  const ok = Boolean(responseOk && body?.ok === true && emailSent === true);
  const outcome = ok
    ? 'sent'
    : reconciliationRequired
      ? 'reconciliation_required'
      : Number(httpStatus) === 409
        ? 'conflict'
        : retrySafe
          ? 'retryable_failure'
          : 'failed';
  return {
    ok,
    http_status: Number(httpStatus) || 0,
    outcome,
    email_sent: emailSent,
    retry_safe: retrySafe,
    reconciliation_required: reconciliationRequired,
    ...(body?.error ? { error: String(body.error).slice(0, 1000) } : {}),
  };
}

export function classifyFollowupStateAfterInvocation(previousLead, currentLead) {
  const currentStatus = String(currentLead?.status || '');
  const previousStep = Number(previousLead?.follow_up_step || 0);
  const currentStep = Number(currentLead?.follow_up_step || 0);
  const previousMessageId = String(previousLead?.gmail_message_id || '');
  const currentMessageId = String(currentLead?.gmail_message_id || '');
  const sentStateObserved = currentStatus === 'sent'
    && currentStep > previousStep
    && Boolean(currentMessageId)
    && currentMessageId !== previousMessageId;
  const reconciliationRequired = currentStatus === 'reconciliation_required';

  return {
    ok: false,
    http_status: 0,
    outcome: reconciliationRequired
      ? 'reconciliation_required'
      : currentStatus === 'sending'
        ? 'send_in_progress'
        : sentStateObserved
          ? 'sent_state_observed'
          : 'invocation_unknown',
    email_sent: sentStateObserved ? true : null,
    retry_safe: false,
    reconciliation_required: reconciliationRequired,
  };
}

export function summariseFollowupResults(results, totalDue) {
  const attempted = results.length;
  const succeeded = results.filter(result => result.ok).length;
  const reconciliationRequired = results
    .filter(result => result.reconciliation_required)
    .length;
  const failed = attempted - succeeded;
  const deferred = Math.max(0, Number(totalDue || 0) - attempted);
  const ok = failed === 0 && deferred === 0;
  return {
    ok,
    partial: !ok && succeeded > 0,
    attempted,
    succeeded,
    failed,
    reconciliationRequired,
    deferred,
  };
}
