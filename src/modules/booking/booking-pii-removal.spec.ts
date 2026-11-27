import { maskMobile } from '../../common/validation/indian-mobile';
import { WorkerDisplayView, WorkerBookingView } from './dto/booking.dto';
import { InterviewWorkerView, InterviewView } from './dto/interview.dto';

describe('PII Masking Removal & Contact Exposure in Booking and Interview', () => {
  describe('maskMobile() helper', () => {
    it('returns full unmasked phone number for legitimate contact access', () => {
      expect(maskMobile('+919876543210')).toBe('+919876543210');
      expect(maskMobile('9876543210')).toBe('9876543210');
      expect(maskMobile(null)).toBeNull();
      expect(maskMobile(undefined)).toBeNull();
    });
  });

  describe('WorkerDisplayView contact fields', () => {
    it('exposes phone and mobile on WorkerDisplayView for confirmed customer bookings', () => {
      const view: WorkerDisplayView = {
        displayName: 'Ramesh K.',
        name: 'Ramesh K.',
        verified: true,
        initials: 'RK',
        photo: null,
        photoUrl: null,
        phone: '+919876543210',
        mobile: '+919876543210',
      };

      expect(view.phone).toBe('+919876543210');
      expect(view.mobile).toBe('+919876543210');
    });
  });

  describe('WorkerBookingView contact fields', () => {
    it('exposes customerPhone and customerName on WorkerBookingView for confirmed worker bookings', () => {
      const view: WorkerBookingView = {
        id: '01933c2a-7000-7000-8000-000000000001',
        status: 'CONFIRMED',
        category: { code: 'MAID', name: 'Maid' },
        area: {
          id: '01933c2a-7000-7000-8000-000000000002',
          name: 'Koramangala',
          city: 'Bengaluru',
        },
        engagement: 'ONE_TIME',
        availableFrom: '09:00',
        availableTo: '13:00',
        scheduleType: null,
        scheduledAt: null,
        startDate: '2026-12-01',
        requestedStartDate: '2026-12-01',
        budgetMinMinor: null,
        budgetMaxMinor: null,
        budgetPeriod: null,
        requirementNote: null,
        workerRespondedAt: new Date(),
        respondBy: null,
        proposedSlotAt: null,
        proposedSlotNote: null,
        customerPhone: '+919876543210',
        customerName: 'Asha Rao',
        updatedAt: new Date(),
      };

      expect(view.customerPhone).toBe('+919876543210');
      expect(view.customerName).toBe('Asha Rao');
    });
  });

  describe('Interview views contact fields', () => {
    it('exposes phone on InterviewWorkerView for customers viewing interview details', () => {
      const worker: InterviewWorkerView = {
        workerId: '01933c2a-7000-7000-8000-000000000003',
        name: 'Ramesh K.',
        initials: 'RK',
        photoUrl: null,
        phone: '+919876543210',
      };

      expect(worker.phone).toBe('+919876543210');
    });

    it('exposes customerPhone and customerName on InterviewView for workers viewing interview details', () => {
      const view: InterviewView = {
        id: '01933c2a-7000-7000-8000-000000000004',
        bookingId: '01933c2a-7000-7000-8000-000000000001',
        type: 'INTERVIEW',
        status: 'CONFIRMED',
        statusLabel: 'Confirmed',
        requestedBy: 'CUSTOMER',
        preferredAt: new Date(),
        scheduledAt: new Date(),
        durationMinutes: 60,
        proposedAt: null,
        proposedBy: null,
        note: null,
        declineReason: null,
        cancelReason: null,
        outcomeNote: null,
        completedAt: null,
        cancelledAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        allowedActions: ['cancel'],
        timeline: [],
        customerPhone: '+919876543210',
        customerName: 'Asha Rao',
      };

      expect(view.customerPhone).toBe('+919876543210');
      expect(view.customerName).toBe('Asha Rao');
    });
  });
});
