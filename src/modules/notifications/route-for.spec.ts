import { routeFor } from './notifications.service';

describe('routeFor (push and inbox deep links)', () => {
  const ids = {
    bookingId: 'b1',
    paymentId: 'p1',
    replacementId: 'r1',
    interviewId: 'i1',
    ticketId: 't1',
  };

  it.each([
    ['PAYMENT_SUCCEEDED', 'payment', 'p1'],
    ['PAYMENT_FAILED', 'payment', 'p1'],
    ['PAYMENT_UNDER_REVIEW', 'payment', 'p1'],
    ['REPLACEMENT_UPDATE', 'replacement', 'r1'],
    ['INTERVIEW_REQUESTED', 'interview', 'i1'],
    ['INTERVIEW_RESPONDED', 'interview', 'i1'],
    ['INTERVIEW_CANCELLED', 'interview', 'i1'],
  ])('%s routes to its own entity (%s)', (event, type, id) => {
    expect(routeFor(ids, event)).toEqual({ type, id });
  });

  it('keeps booking for events that only describe a booking, even when other ids are present', () => {
    for (const event of [
      'BOOKING_CONFIRMED',
      'WORKER_ACCEPTED',
      'INTERVIEW_TRIAL_SCHEDULED',
      'BOOKING_SLOT_PROPOSED',
    ]) {
      expect(routeFor(ids, event)).toEqual({ type: 'booking', id: 'b1' });
    }
  });

  it('falls back when the entity id is missing, never inventing one', () => {
    expect(routeFor({ bookingId: 'b1' }, 'PAYMENT_SUCCEEDED')).toEqual({
      type: 'booking',
      id: 'b1',
    });
    expect(routeFor({ paymentId: 'p1' }, 'INTERVIEW_REQUESTED')).toEqual({
      type: 'payment',
      id: 'p1',
    });
    expect(routeFor({}, 'PAYMENT_SUCCEEDED')).toBeNull();
    expect(routeFor({ checkType: 'IDENTITY' }, 'VERIFICATION_APPROVED')).toBeNull();
  });

  it('keeps the old behaviour when no event is given or the event is unknown', () => {
    expect(routeFor(ids)).toEqual({ type: 'booking', id: 'b1' });
    expect(routeFor({ ticketId: 't1' }, 'TICKET_UPDATE')).toEqual({ type: 'ticket', id: 't1' });
    expect(routeFor({ replacementId: 'r1' }, 'SOMETHING_ELSE')).toEqual({
      type: 'replacement',
      id: 'r1',
    });
  });
});
