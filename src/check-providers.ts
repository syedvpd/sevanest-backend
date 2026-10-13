import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppConfigModule } from './config/config.module';
import { AppConfigService } from './config/app-config.service';
import {
  MessagingProviderKind,
  PaymentProviderKind,
  SmsProviderKind,
  StorageProviderKind,
} from './config/env.validation';
import { ClamAvMalwareScanner } from './integrations/malware/malware-scanner';
import { RazorpayPaymentProvider } from './integrations/payments/razorpay-payment.provider';
import { S3StorageProvider } from './integrations/storage/s3-storage.provider';

@Module({ imports: [AppConfigModule] })
class CheckProvidersModule {}

type Result = {
  name: string;
  status: 'OK' | 'FAILED' | 'NOT_CONFIGURED' | 'SKIPPED';
  detail: string;
};

const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

/**
 * `npm run check:providers` (after `npm run build`): a safe, read-only-as-far-as-possible check of every provider the current
 * environment configures. It never prints a secret, never touches the database and never sends an SMS or a message.
 *  - Razorpay: only with TEST keys (rzp_test_...): creates one Rs 1 test order and looks it up. Live keys are refused.
 *  - Twilio: reads the account record (credentials check, no message).
 *  - S3 / Supabase Storage: asks for a key that does not exist (proves credentials, bucket and endpoint).
 *  - ClamAV: scans the harmless EICAR test string; it must be reported as infected.
 * MSG91 and FCM have no read-only call: use the staging test OTP and a real device token (docs/qa/OPERATIONS_RUNBOOK.md).
 * Anything that needs a customer to pay (checkout, webhook, refund) is a manual sandbox session, not part of this command.
 */
async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(CheckProvidersModule, {
    logger: ['error', 'warn'],
  });
  const config = app.get(AppConfigService);
  const results: Result[] = [];
  const run = async (name: string, work: () => Promise<string>): Promise<void> => {
    try {
      results.push({ name, status: 'OK', detail: await work() });
    } catch (error) {
      results.push({ name, status: 'FAILED', detail: (error as Error).message.slice(0, 200) });
    }
  };

  if (config.paymentProvider === PaymentProviderKind.Razorpay) {
    const settings = config.razorpay;
    if (!settings.keyId.startsWith('rzp_test_')) {
      results.push({
        name: 'razorpay',
        status: 'SKIPPED',
        detail: 'live keys detected: this command only talks to Razorpay with test keys',
      });
    } else {
      await run('razorpay', async () => {
        const provider = new RazorpayPaymentProvider(settings);
        const reference = `check-${Date.now()}`;
        const order = await provider.createOrder({
          amountMinor: 100,
          currency: 'INR',
          reference,
          idempotencyKey: reference,
        });
        const payments = await provider.findPaymentsForOrder(order.providerOrderId);
        return `test order created and looked up (${payments.length} payments, expected 0); checkout, webhook and refund still need a manual sandbox session`;
      });
    }
  } else {
    results.push({
      name: 'razorpay',
      status: 'NOT_CONFIGURED',
      detail: `PAYMENT_PROVIDER=${config.paymentProvider}`,
    });
  }

  if (config.smsProvider === SmsProviderKind.Twilio) {
    await run('twilio', async () => {
      const t = config.twilio;
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${t.accountSid}.json`, {
        headers: {
          Authorization: `Basic ${Buffer.from(`${t.accountSid}:${t.authToken}`).toString('base64')}`,
        },
        signal: AbortSignal.timeout(t.timeoutMs),
      });
      if (!res.ok) throw new Error(`Twilio answered HTTP ${res.status}`);
      const body = (await res.json()) as { status?: string; type?: string };
      return `account reachable (status ${body.status ?? '?'}, type ${body.type ?? '?'}); no message was sent`;
    });
  } else {
    results.push({
      name: 'sms',
      status: config.smsProvider === SmsProviderKind.Msg91 ? 'SKIPPED' : 'NOT_CONFIGURED',
      detail:
        config.smsProvider === SmsProviderKind.Msg91
          ? 'MSG91 has no read-only call: request an OTP for your own number'
          : `SMS_PROVIDER=${config.smsProvider}`,
    });
  }

  if (config.storageProvider === StorageProviderKind.S3) {
    await run('storage', async () => {
      const info = await new S3StorageProvider(config.storageS3).getObjectInfo(
        `healthcheck/${Date.now()}.none`,
      );
      return info === null
        ? 'bucket reachable with these credentials (the probe key correctly does not exist)'
        : 'unexpected: probe key exists';
    });
  } else {
    results.push({
      name: 'storage',
      status: 'NOT_CONFIGURED',
      detail: `STORAGE_PROVIDER=${config.storageProvider}`,
    });
  }

  const clam = config.clamav;
  if (clam) {
    await run('clamav', async () => {
      const verdict = await new ClamAvMalwareScanner(clam).scan(Buffer.from(EICAR));
      if (verdict.clean)
        throw new Error('the EICAR test string was reported clean: the scanner is not working');
      return `scanner answers and detects the EICAR test file (${verdict.signature ?? 'signature n/a'})`;
    });
  } else {
    results.push({ name: 'clamav', status: 'NOT_CONFIGURED', detail: 'CLAMAV_HOST not set' });
  }

  results.push({
    name: 'fcm',
    status: config.pushProvider === MessagingProviderKind.Fcm ? 'SKIPPED' : 'NOT_CONFIGURED',
    detail: 'no read-only call: send a test push to a real device token',
  });

  for (const r of results) console.log(`${r.status.padEnd(15)} ${r.name.padEnd(10)} ${r.detail}`);
  await app.close();
  process.exit(results.some((r) => r.status === 'FAILED') ? 1 : 0);
}

main().catch((error: unknown) => {
  console.error('check:providers failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
