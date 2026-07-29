export function buildSendClaimState(
  lead,
  isFollowUp,
  followUpStep,
  actorId,
  claimedAt,
) {
  return {
    updates: {
      status: 'sending',
      send_claimed_at: claimedAt,
      send_error: null,
      follow_up_step: isFollowUp ? followUpStep : Number(lead.follow_up_step || 0),
      next_follow_up_at: null,
      updated_at: claimedAt,
      updated_by: actorId,
    },
    previous: {
      status: lead.status,
      sent_at: lead.sent_at || null,
      follow_up_step: Number(lead.follow_up_step || 0),
      next_follow_up_at: lead.next_follow_up_at || null,
    },
  };
}

export function buildSendClaimRelease(claim, actorId, releasedAt) {
  return {
    status: claim.previous.status,
    sent_at: claim.previous.sent_at,
    follow_up_step: claim.previous.follow_up_step,
    next_follow_up_at: claim.previous.next_follow_up_at,
    send_claimed_at: null,
    send_error: null,
    updated_at: releasedAt,
    updated_by: actorId,
  };
}

export function buildSendReconciliationState(
  claim,
  actorId,
  reconciledAt,
  error,
) {
  return {
    status: 'reconciliation_required',
    send_claimed_at: claim.claimedAt,
    send_error: String(error || 'Gmail send requires manual reconciliation').slice(0, 1000),
    updated_at: reconciledAt,
    updated_by: actorId,
  };
}

export function isUnknownGmailFailureStatus(status) {
  const numericStatus = Number(status);
  return numericStatus === 408 || numericStatus >= 500;
}
