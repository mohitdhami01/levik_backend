import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { buildDataSourceOptions } from '../src/database/data-source-options.js';
import { DEMO_PASSWORD, seedDemoData } from '../src/database/seeds/seed.js';
import { TokenService } from '../src/modules/auth/services/token.service.js';
import { SchemeSchedulerService } from '../src/modules/schemes/services/scheme-scheduler.service.js';
import { setupApp } from '../src/setup-app.js';

/**
 * Full-stack tests: real AppModule + HTTP pipeline against a disposable Postgres database
 * (levik_test, migrated and reseeded before the run). Mirrors the client demo scenarios.
 */
describe('Levik API (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let admin: string;
  const api = (path: string) => `/api/v1${path}`;

  beforeAll(async () => {
    const ds = new DataSource(
      buildDataSourceOptions({ url: process.env.DATABASE_URL!, ssl: false, logging: false, runMigrations: false, poolSize: 2 }),
    );
    await ds.initialize();
    await ds.runMigrations();
    await seedDemoData(ds, { reset: true });
    await ds.destroy();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    setupApp(app);
    await app.init();
    http = request(app.getHttpServer());

    const login = await http.post(api('/auth/admin/login')).send({ email: 'admin@levik.demo', password: DEMO_PASSWORD });
    expect(login.status).toBe(200);
    admin = `Bearer ${login.body.accessToken}`;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  const balance = async (userId: string) =>
    (await http.get(api(`/admin/points/balances/${userId}`)).set('authorization', admin)).body.available as number;

  describe('auth', () => {
    it('rejects bad credentials with the error envelope', async () => {
      const res = await http.post(api('/auth/admin/login')).send({ email: 'admin@levik.demo', password: 'wrong-password' });
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ statusCode: 401, code: expect.any(String), path: api('/auth/admin/login') });
    });

    it('requires a token on admin routes and validates input', async () => {
      expect((await http.get(api('/admin/dashboard'))).status).toBe(401);
      const res = await http.post(api('/auth/admin/login')).send({ email: 'not-an-email', password: 'x', extra: true });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    });

    it('rotates refresh tokens and detects reuse', async () => {
      const login = await http.post(api('/auth/admin/login')).send({ email: 'admin@levik.demo', password: DEMO_PASSWORD });
      const first = login.body.refreshToken;
      const rotated = await http.post(api('/auth/refresh')).send({ refreshToken: first });
      expect(rotated.status).toBe(200);
      expect(rotated.body.refreshToken).not.toBe(first);
      const reused = await http.post(api('/auth/refresh')).send({ refreshToken: first });
      expect(reused.status).toBe(401);
      // Reuse revokes the whole family, including the rotated token.
      expect((await http.post(api('/auth/refresh')).send({ refreshToken: rotated.body.refreshToken })).status).toBe(401);
    });
  });

  describe('scenario A: scan approval', () => {
    it('credits scan points and the scheme bonus exactly once', async () => {
      expect(await balance('PLM-1001')).toBe(4080);
      const res = await http.post(api('/admin/scans/SCN-5007/approve')).set('authorization', admin).send({});
      expect(res.status).toBe(200);
      expect(res.body.points).toBe(350);
      expect(res.body.schemeAwards).toEqual([expect.objectContaining({ id: 'SCH-402', incentivePoints: 1000 })]);
      expect(await balance('PLM-1001')).toBe(5430);

      const again = await http.post(api('/admin/scans/SCN-5007/approve')).set('authorization', admin).send({});
      expect(again.status).toBe(409);
      expect(await balance('PLM-1001')).toBe(5430);
    });

    it('blocks approval of an already credited serial', async () => {
      const res = await http.post(api('/admin/scans/SCN-5015/approve')).set('authorization', admin).send({});
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('CHECKS_FAILED');
      const reject = await http
        .post(api('/admin/scans/SCN-5015/reject'))
        .set('authorization', admin)
        .send({ reason: 'Serial already credited on SCN-5003' });
      expect(reject.status).toBe(200);
    });
  });

  describe('scenario B: invoice approval', () => {
    it('credits the incentive and retail scheme bonus', async () => {
      const before = await balance('RTL-2001');
      const res = await http.post(api('/admin/invoices/INV-3009/approve')).set('authorization', admin).send({});
      expect(res.status).toBe(200);
      expect(res.body.points).toBe(711);
      expect(res.body.schemeAwards[0]).toMatchObject({ id: 'SCH-401', incentivePoints: 5000 });
      expect(await balance('RTL-2001')).toBe(before + 711 + 5000);
    });

    it('blocks a duplicate invoice number', async () => {
      const res = await http.post(api('/admin/invoices/INV-3010/approve')).set('authorization', admin).send({});
      expect(res.status).toBe(422);
    });
  });

  describe('scenario C: redemption', () => {
    it('debits once on approval and never again on later transitions', async () => {
      expect(await balance('PLM-1004')).toBe(5420);
      const approve = await http.post(api('/admin/redemptions/RDM-7004/approve')).set('authorization', admin).send({});
      expect(approve.status).toBe(200);
      expect(approve.body.reward.stock).toBe(11);
      for (const status of ['Processing', 'Dispatched']) {
        const res = await http
          .post(api('/admin/redemptions/RDM-7004/status'))
          .set('authorization', admin)
          .send({ status, courierName: 'Blue Dart', trackingNumber: 'BD123456' });
        expect(res.status).toBe(200);
      }
      expect(await balance('PLM-1004')).toBe(2920);
    });

    it('blocks a redemption the balance cannot cover', async () => {
      const res = await http.post(api('/admin/redemptions/RDM-7006/approve')).set('authorization', admin).send({});
      expect(res.status).toBe(422);
    });

    it('serialises concurrent approvals so points are debited once', async () => {
      const id = 'RDM-7005';
      const results = await Promise.all(
        Array.from({ length: 5 }, () => http.post(api(`/admin/redemptions/${id}/approve`)).set('authorization', admin).send({})),
      );
      const ok = results.filter((r) => r.status === 200);
      expect(ok.length).toBeLessThanOrEqual(1);
      const ledger = await http.get(api('/admin/points/ledger')).query({ search: id, pageSize: 50 }).set('authorization', admin);
      const debits = ledger.body.items.filter((t: { referenceId?: string; type: string }) => t.referenceId === id && t.type === 'Debit');
      expect(debits.length).toBe(ok.length);
    });
  });

  describe('QR labels and the mobile scan flow', () => {
    let payload: string;
    let plumber: string;

    it('generates a label batch with PDF and CSV exports', async () => {
      const batch = await http
        .post(api('/admin/products/PRD-103/label-batches'))
        .set('authorization', admin)
        .send({ quantity: 10, note: 'e2e' });
      expect(batch.status).toBe(201);
      expect(batch.body).toMatchObject({ productId: 'PRD-103', quantity: 10, available: 10 });

      const pdf = await http.get(api(`/admin/label-batches/${batch.body.id}/labels.pdf`)).set('authorization', admin).buffer();
      expect(pdf.status).toBe(200);
      expect(pdf.headers['content-type']).toContain('application/pdf');

      const csv = await http.get(api(`/admin/label-batches/${batch.body.id}/labels.csv`)).set('authorization', admin);
      const rows = csv.text.trim().split('\n');
      expect(rows).toHaveLength(11);
      payload = rows[1].split(',').at(-1)!;
      expect(payload).toMatch(/^https:\/\/levik\.in\/v\/LVK-/);
    });

    it('verifies genuine labels publicly and rejects tampered ones', async () => {
      const genuine = await http.get(api('/public/labels/verify')).query({ code: payload });
      expect(genuine.body).toMatchObject({ genuine: true, status: 'Available' });
      const forged = await http.get(api('/public/labels/verify')).query({ code: `${payload.slice(0, -2)}zz` });
      expect(forged.body.genuine).toBe(false);
    });

    it('signs a plumber in with OTP and submits a scan once', async () => {
      expect((await http.post(api('/auth/otp/request')).send({ phone: '9829011234' })).status).toBe(200);
      const verify = await http.post(api('/auth/otp/verify')).send({ phone: '9829011234', code: '123456' });
      expect(verify.body.user).toMatchObject({ id: 'PLM-1001', role: 'plumber' });
      plumber = `Bearer ${verify.body.accessToken}`;

      const resolved = await http.get(api('/app/labels/resolve')).query({ code: payload }).set('authorization', plumber);
      expect(resolved.body).toMatchObject({ signatureValid: true, status: 'Available', productId: 'PRD-103' });

      const scan = await http.post(api('/app/scans')).set('authorization', plumber).send({ code: payload, retailerId: 'RTL-2001' });
      expect(scan.status).toBe(201);
      expect(scan.body).toMatchObject({ status: 'Pending', points: 350 });

      const dup = await http.post(api('/app/scans')).set('authorization', plumber).send({ code: payload, retailerId: 'RTL-2001' });
      expect(dup.status).toBe(422);

      // Approving the new scan claims the unit.
      const approve = await http.post(api(`/admin/scans/${scan.body.id}/approve`)).set('authorization', admin).send({});
      expect(approve.status).toBe(200);
      const verifyAfter = await http.get(api('/public/labels/verify')).query({ code: payload });
      expect(verifyAfter.body.status).toBe('Claimed');
    });

    it('keeps plumbers out of admin routes', async () => {
      expect((await http.get(api('/admin/dashboard')).set('authorization', plumber)).status).toBe(403);
    });

    it('registers a new plumber through the guest flow', async () => {
      await http.post(api('/auth/otp/request')).send({ phone: '9900011122' });
      const guest = await http.post(api('/auth/otp/verify')).send({ phone: '9900011122', code: '123456' });
      expect(guest.body.user.role).toBe('guest');
      const guestToken = `Bearer ${guest.body.accessToken}`;
      expect((await http.get(api('/app/wallet')).set('authorization', guestToken)).status).toBe(403);

      const reg = await http
        .post(api('/app/plumbers/register'))
        .set('authorization', guestToken)
        .send({ name: 'Test Fitter', city: 'Jaipur', state: 'Rajasthan', pincode: '302001' });
      expect(reg.status).toBe(201);
      expect(reg.body.user).toMatchObject({ role: 'plumber', name: 'Test Fitter' });
    });
  });

  describe('explore (where to buy, what it earns)', () => {
    // Tokens straight from the TokenService: the OTP flow is covered above and rate-limits repeat requests per number.
    const signIn = async (phone: string) => {
      const sub = phone === '9829041127' ? { sub: 'RTL-2001', role: 'retailer' as const } : { sub: 'PLM-1001', role: 'plumber' as const };
      const tokens = await app.get(TokenService).issue({ ...sub, phone: `91${phone}` });
      return `Bearer ${tokens.accessToken}`;
    };

    it('lists products with role-specific earnings and dealer counts', async () => {
      const plumber = await signIn('9829011234');
      const res = await http.get(api('/app/explore/products')).query({ pageSize: 50 }).set('authorization', plumber);
      expect(res.status).toBe(200);
      const wc = res.body.items.find((p: { id: string }) => p.id === 'PRD-103');
      expect(wc).toMatchObject({ earning: { points: 350, basis: 'per approved scan' } });
      expect(wc.dealersInStock).toBeGreaterThan(0);
      expect(wc.earning.schemes.map((s: { id: string }) => s.id)).toContain('SCH-402');
      expect(wc).not.toHaveProperty('mrp');
    });

    it('shows dealers stocking a product with the caller city first', async () => {
      const plumber = await signIn('9829011234');
      const res = await http.get(api('/app/explore/products/PRD-103')).set('authorization', plumber);
      expect(res.status).toBe(200);
      expect(res.body.city).toBe('Jaipur');
      expect(res.body.dealers[0]).toMatchObject({ id: 'RTL-2001', sameCity: true });
      expect(res.body.dealers.every((d: { quantity: number }) => d.quantity > 0)).toBe(true);
    });

    it('shows a dealer with every product in stock and what each earns', async () => {
      const plumber = await signIn('9829011234');
      const res = await http.get(api('/app/explore/dealers/RTL-2001')).set('authorization', plumber);
      expect(res.status).toBe(200);
      expect(res.body.dealer.shopName).toBe('Sharma Sanitary Store');
      expect(res.body.products.length).toBeGreaterThan(0);
      expect(res.body.products[0]).toEqual(expect.objectContaining({ quantity: expect.any(Number), stockLevel: expect.any(String), earning: expect.any(Object) }));
      expect((await http.get(api('/app/explore/dealers/RTL-9999')).set('authorization', plumber)).status).toBe(404);
    });

    it('gives retailers their price and incentive, never other shops\' stock', async () => {
      const retailer = await signIn('9829041127');
      const res = await http.get(api('/app/explore/products/PRD-103')).set('authorization', retailer);
      expect(res.status).toBe(200);
      // 1 pt per ₹100 of MRP ₹18,500 → 185 pts per unit.
      expect(res.body.product.earning).toMatchObject({ points: 185, basis: 'per unit sold at MRP' });
      expect(res.body.product).toMatchObject({ listPrice: 18500 });
      expect(res.body.product).not.toHaveProperty('dealersInStock');
      expect(res.body.dealers).toEqual([]);

      const list = await http.get(api('/app/explore/products')).query({ pageSize: 50 }).set('authorization', retailer);
      expect(list.body.items.every((p: object) => !('dealersInStock' in p) && 'listPrice' in p)).toBe(true);
      expect((await http.get(api('/app/explore/dealers')).set('authorization', retailer)).status).toBe(403);
      expect((await http.get(api('/app/explore/dealers/RTL-2001')).set('authorization', retailer)).status).toBe(403);
    });

    it('is not available to admins', async () => {
      expect((await http.get(api('/app/explore/products')).set('authorization', admin)).status).toBe(403);
    });
  });

  describe('photos and signed file links', () => {
    // 1×1 transparent PNG.
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
    const token = async (sub: string, role: 'plumber' | 'retailer', phone: string) =>
      `Bearer ${(await app.get(TokenService).issue({ sub, role, phone })).accessToken}`;

    it('uploads a shop photo, attaches it and serves it through a signed link', async () => {
      const retailer = await token('RTL-2001', 'retailer', '919829041127');
      const upload = await http.post(api('/uploads')).set('authorization', retailer).field('purpose', 'shop-photo').attach('file', png, 'shop.png');
      expect(upload.status).toBe(201);
      expect(upload.body.url).toMatch(/^\/api\/v1\/files\/shop-photo_[0-9a-f-]{36}\.png\?exp=\d+&sig=[\w-]{32}$/);

      const me = await http.patch(api('/app/retailers/me')).set('authorization', retailer).send({ shopPhotoKey: upload.body.key });
      expect(me.status).toBe(200);
      expect(me.body.shopPhotoUrl).toMatch(/^\/api\/v1\/files\/shop-photo_/);
      expect(me.body).not.toHaveProperty('shopPhotoKey');

      const stores = await http.get(api('/app/stores')).query({ search: 'Sharma' }).set('authorization', retailer);
      expect(stores.body.items.find((s: { id: string }) => s.id === 'RTL-2001').shopPhotoUrl).toBeDefined();

      // No auth header: <Image> and <img> load the link directly, from other origins.
      const file = await http.get(me.body.shopPhotoUrl);
      expect(file.status).toBe(200);
      expect(file.headers['content-type']).toBe('image/png');
      expect(file.headers['cross-origin-resource-policy']).toBe('cross-origin');
      expect(Buffer.compare(file.body as Buffer, png)).toBe(0);

      const tampered = (me.body.shopPhotoUrl as string).replace(/sig=(.)/, (_, c: string) => `sig=${c === 'A' ? 'B' : 'A'}`);
      expect((await http.get(tampered)).status).toBe(404);
    });

    it('sets a plumber profile photo and refuses uploads that are not theirs or of the wrong kind', async () => {
      const plumber = await token('PLM-1001', 'plumber', '919829011234');
      const own = await http.post(api('/uploads')).set('authorization', plumber).field('purpose', 'profile-photo').attach('file', png, 'me.png');
      expect(own.status).toBe(201);
      const me = await http.patch(api('/app/plumbers/me')).set('authorization', plumber).send({ photoKey: own.body.key });
      expect(me.status).toBe(200);
      expect(me.body.photoUrl).toMatch(/^\/api\/v1\/files\/profile-photo_/);

      const retailer = await token('RTL-2001', 'retailer', '919829041127');
      const theirs = await http.post(api('/uploads')).set('authorization', retailer).field('purpose', 'profile-photo').attach('file', png, 'them.png');
      expect((await http.patch(api('/app/plumbers/me')).set('authorization', plumber).send({ photoKey: theirs.body.key })).status).toBe(422);

      const sitePhoto = await http.post(api('/uploads')).set('authorization', plumber).field('purpose', 'scan-photo').attach('file', png, 'site.png');
      expect((await http.patch(api('/app/plumbers/me')).set('authorization', plumber).send({ photoKey: sitePhoto.body.key })).status).toBe(422);

      expect((await http.post(api('/uploads')).set('authorization', plumber).field('purpose', 'shop-photo').attach('file', png, 'x.png')).status).toBe(422);

      const cleared = await http.patch(api('/app/plumbers/me')).set('authorization', plumber).send({ photoKey: null });
      expect(cleared.body.photoUrl).toBeUndefined();
    });
  });

  describe('orders, stock, plumber sales and bills', () => {
    const RETAILER = 'RTL-2001';
    let retailer: string;
    let plumber: string;
    let ds: DataSource;
    const stockOf = async (productId: string) =>
      ((await ds.query(`select quantity from inventory where retailer_id = $1 and product_id = $2`, [RETAILER, productId])) as Array<{ quantity: number }>)[0]?.quantity ?? 0;
    const availableUnit = async (excludeProduct?: string) =>
      (
        (await ds.query(
          `select u.serial, u.product_id as "productId" from product_units u join products p on p.id = u.product_id
            where u.status = 'Available' and p.is_active and p.reward_eligible and ($1::text is null or u.product_id <> $1)
              and not exists (select 1 from scans s where s.product_unit_serial = u.serial)
            order by u.serial limit 1`,
          [excludeProduct ?? null],
        )) as Array<{ serial: string; productId: string }>
      )[0];

    beforeAll(async () => {
      ds = app.get(DataSource);
      const tokens = app.get(TokenService);
      retailer = `Bearer ${(await tokens.issue({ sub: RETAILER, role: 'retailer', phone: '919829041127' })).accessToken}`;
      // A verified plumber other than PLM-1001, so earlier tests do not use up its daily scan limit.
      const [p] = (await ds.query(
        `select id, mobile from plumbers where verification_status = 'Verified' and account_status = 'Active' and id <> 'PLM-1001' order by id limit 1`,
      )) as Array<{ id: string; mobile: string }>;
      plumber = `Bearer ${(await tokens.issue({ sub: p.id, role: 'plumber', phone: p.mobile.replace(/\D/g, '') })).accessToken}`;
    });

    it('takes an order from placed to delivered, adding stock and issuing a purchase invoice', async () => {
      const unit = await availableUnit();
      const before = await stockOf(unit.productId);
      const placed = await http.post(api('/app/orders')).set('authorization', retailer).send({ lines: [{ productId: unit.productId, quantity: 3 }], note: 'E2E restock' });
      expect(placed.status).toBe(201);
      expect(placed.body).toMatchObject({ status: 'Placed', itemCount: 3, retailerId: RETAILER, nextStatuses: ['Confirmed', 'Cancelled'] });
      expect(placed.body.totalValue).toBe(3 * placed.body.lines[0].unitPrice);
      const id = placed.body.id as string;

      expect((await http.get(api('/admin/orders')).query({ retailerId: RETAILER }).set('authorization', admin)).body.items.map((o: { id: string }) => o.id)).toContain(id);
      const skip = await http.post(api(`/admin/orders/${id}/status`)).set('authorization', admin).send({ status: 'Delivered' });
      expect(skip.status).toBe(409);

      for (const status of ['Confirmed', 'Dispatched']) {
        expect((await http.post(api(`/admin/orders/${id}/status`)).set('authorization', admin).send({ status })).body.status).toBe(status);
      }
      const delivered = await http.post(api(`/admin/orders/${id}/status`)).set('authorization', admin).send({ status: 'Delivered' });
      expect(delivered.status).toBe(200);
      expect(delivered.body.purchaseInvoiceNumber).toMatch(/^LVK\/PI\/\d{4}\/\d{5}$/);
      expect(await stockOf(unit.productId)).toBe(before + 3);

      const pdf = await http.get(delivered.body.purchaseInvoiceUrl).buffer(true).parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
      expect(pdf.status).toBe(200);
      expect(pdf.headers['content-type']).toBe('application/pdf');
      expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');

      const moves = await http.get(api('/app/inventory/movements')).query({ productId: unit.productId }).set('authorization', retailer);
      expect(moves.body.items[0]).toMatchObject({ reason: 'Order delivered', delta: 3, balanceAfter: before + 3, relatedType: 'order', relatedId: id });

      // Delivered orders cannot be cancelled.
      expect((await http.post(api(`/admin/orders/${id}/status`)).set('authorization', admin).send({ status: 'Cancelled', reason: 'Too late now' })).status).toBe(409);
    });

    it('credits retailer and plumber when the retailer confirms a sale, and bills the buyer', async () => {
      const unit = await availableUnit();
      await http.put(api(`/app/inventory/${unit.productId}`)).set('authorization', retailer).send({ quantity: 5 });
      const scan = await http.post(api('/app/scans')).set('authorization', plumber).send({ code: unit.serial, retailerId: RETAILER });
      expect(scan.status).toBe(201);
      expect(scan.body).toMatchObject({ status: 'Pending', awaitingRetailer: true });

      const pending = await http.get(api('/app/sales')).query({ decision: 'Pending' }).set('authorization', retailer);
      const sale = pending.body.items.find((s: { scanId: string }) => s.scanId === scan.body.id);
      expect(sale).toMatchObject({ decision: 'Pending', productId: unit.productId });
      expect(sale.incentivePoints).toBeGreaterThan(0);

      const confirmed = await http
        .post(api(`/app/sales/${scan.body.id}/confirm`))
        .set('authorization', retailer)
        .send({ bill: { customerName: 'Aman Kumar', customerMobile: '9876543210' } });
      expect(confirmed.status).toBe(200);
      expect(confirmed.body).toMatchObject({ retailerPoints: sale.incentivePoints, autoApproved: true, pendingReasons: [] });
      expect(await stockOf(unit.productId)).toBe(4);

      const review = await http.get(api(`/admin/scans/${scan.body.id}`)).set('authorization', admin);
      expect(review.body.scan).toMatchObject({ status: 'Approved', retailerDecision: 'Confirmed', retailerPoints: sale.incentivePoints });
      expect(review.body.checks.find((c: { label: string }) => c.label === 'Retailer confirmed the sale').passed).toBe(true);

      const bills = await http.get(api('/app/bills')).set('authorization', retailer);
      expect(bills.body.items[0]).toMatchObject({ customerName: 'Aman Kumar', customerMobile: '+91 98765 43210', scanId: scan.body.id, billNumber: expect.stringMatching(/^B-\d{4}$/) });
      expect((await http.get(confirmed.body.billPdfUrl)).headers['content-type']).toBe('application/pdf');

      // A bill raised with the sale does not take stock out a second time; confirming twice is refused.
      expect(await stockOf(unit.productId)).toBe(4);
      expect((await http.post(api(`/app/sales/${scan.body.id}/confirm`)).set('authorization', retailer).send({})).status).toBe(409);
    });

    it('refuses to confirm a sale without stock, and a declined sale goes to Levik for review', async () => {
      const unit = await availableUnit();
      await http.put(api(`/app/inventory/${unit.productId}`)).set('authorization', retailer).send({ quantity: 0 });
      const scan = await http.post(api('/app/scans')).set('authorization', plumber).send({ code: unit.serial, retailerId: RETAILER });

      const noStock = await http.post(api(`/app/sales/${scan.body.id}/confirm`)).set('authorization', retailer).send({});
      expect(noStock.status).toBe(422);
      expect(noStock.body.code).toBe('OUT_OF_STOCK');

      expect((await http.post(api(`/app/sales/${scan.body.id}/decline`)).set('authorization', retailer).send({ reason: 'Not sold from this store' })).status).toBe(204);
      const review = await http.get(api(`/admin/scans/${scan.body.id}`)).set('authorization', admin);
      expect(review.body.scan).toMatchObject({ status: 'Flagged', retailerDecision: 'Declined', retailerNote: 'Not sold from this store' });
      expect(await stockOf(unit.productId)).toBe(0);
    });

    it('bills walk-in customers out of stock and keeps the ledger in step with the balance', async () => {
      const unit = await availableUnit();
      await http.put(api(`/app/inventory/${unit.productId}`)).set('authorization', retailer).send({ quantity: 2 });
      const bill = await http.post(api('/app/bills')).set('authorization', retailer).send({ customerName: 'Walk-in customer', lines: [{ productId: unit.productId, quantity: 2, unitPrice: 9999 }] });
      expect(bill.status).toBe(201);
      expect(bill.body).toMatchObject({ totalValue: 19998, customerName: 'Walk-in customer' });
      expect(await stockOf(unit.productId)).toBe(0);
      const tooMany = await http.post(api('/app/bills')).set('authorization', retailer).send({ customerName: 'Walk-in customer', lines: [{ productId: unit.productId, quantity: 1 }] });
      expect(tooMany.status).toBe(422);

      // Every balance equals the sum of its movements.
      const drift = (await ds.query(
        `select i.retailer_id, i.product_id from inventory i
          left join (select retailer_id, product_id, sum(delta) as total from stock_movements group by 1, 2) m using (retailer_id, product_id)
          where i.retailer_id = $1 and i.quantity <> coalesce(m.total, 0)`,
        [RETAILER],
      )) as unknown[];
      expect(drift).toEqual([]);
    });

    it('lets retailers cancel only orders Levik has not confirmed', async () => {
      const unit = await availableUnit();
      const placed = await http.post(api('/app/orders')).set('authorization', retailer).send({ lines: [{ productId: unit.productId, quantity: 1 }] });
      const cancelled = await http.post(api(`/app/orders/${placed.body.id}/cancel`)).set('authorization', retailer).send({ reason: 'Ordered by mistake' });
      expect(cancelled.body).toMatchObject({ status: 'Cancelled', cancelReason: 'Ordered by mistake' });
      expect((await http.get(api(`/app/orders/${placed.body.id}`)).set('authorization', plumber)).status).toBe(403);
    });
  });

  describe('uploaded product images', () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
    const product = (imageUrl: string, sku: string) => ({
      name: 'Uploaded Image WC', modelCode: 'UPL-1', category: 'One-Piece Western WC' as const, description: 'E2E product with an uploaded image.',
      imageUrl, sku, barcode: `89${Date.now()}`.slice(0, 13), mrp: 12000, plumberPoints: 100,
    });

    it('returns an uploaded product image as a signed link', async () => {
      const upload = await http.post(api('/uploads')).set('authorization', admin).field('purpose', 'product-image').attach('file', png, 'wc.png');
      expect(upload.status).toBe(201);
      const created = await http.post(api('/admin/products')).set('authorization', admin).send(product(upload.body.key, `E2E-IMG-${Date.now()}`));
      expect(created.status).toBe(201);
      expect(created.body.imageUrl).toMatch(/^\/api\/v1\/files\/product-image_[0-9a-f-]{36}\.png\?exp=\d+&sig=/);
      expect((await http.get(created.body.imageUrl)).status).toBe(200);
    });

    it('refuses an upload key that is not a product image', async () => {
      const res = await http.post(api('/admin/products')).set('authorization', admin).send(product('product-image_00000000-0000-0000-0000-000000000000.png', `E2E-BAD-${Date.now()}`));
      expect(res.status).toBe(422);
    });
  });

  describe('raw UPDATE … RETURNING queries', () => {
    it('activates a scheduled scheme on its start date and audits it with the scheme id', async () => {
      const ds = app.get(DataSource);
      const [{ id }] = await ds.query(`select id from schemes order by id limit 1`);
      await ds.query(`update schemes set status = 'Scheduled', start_date = now() - interval '1 day', end_date = now() + interval '30 days' where id = $1`, [id]);

      const result = await app.get(SchemeSchedulerService).run();
      expect(result.activated).toContain(id);
      const [audit] = await ds.query(`select entity_id from audit_logs where action = 'Scheme activated' order by at desc limit 1`);
      expect(audit.entity_id).toBe(id);
    });

    it('reports the new reward stock in the audit log after an adjustment', async () => {
      const rewards = await http.get(api('/admin/rewards')).set('authorization', admin);
      const reward = (rewards.body.items ?? rewards.body)[0] as { id: string; stock: number };
      const res = await http.post(api(`/admin/rewards/${reward.id}/stock-adjustments`)).set('authorization', admin).send({ delta: 3, reason: 'Restock for e2e test' });
      expect(res.status).toBe(200);
      const [audit] = await app.get(DataSource).query(`select summary from audit_logs where action = 'Reward stock adjusted' order by at desc limit 1`);
      expect(audit.summary).toContain(`(now ${reward.stock + 3})`);
    });
  });

  describe('admin read models', () => {
    it.each([
      '/admin/dashboard?period=30d',
      '/admin/plumbers?pageSize=5',
      '/admin/retailers?sort=achievementPct',
      '/admin/products',
      '/admin/schemes',
      '/admin/points/ledger/totals',
      '/admin/audit-logs?pageSize=5',
      '/admin/notifications',
      '/admin/search?q=ram',
      '/admin/reports/top-products?period=90d',
    ])('GET %s', async (path) => {
      const res = await http.get(api(path)).set('authorization', admin);
      expect(res.status).toBe(200);
    });

    it("returns one participant's progress across live schemes", async () => {
      const res = await http.get(api('/admin/schemes/progress')).query({ userId: 'RTL-2001' }).set('authorization', admin);
      expect(res.status).toBe(200);
      expect(res.body.length).toBeGreaterThan(0);
      expect(res.body.every((s: { role: string }) => s.role === 'retailer')).toBe(true);
      expect(res.body[0]).toEqual(expect.objectContaining({ progress: expect.any(Number), percent: expect.any(Number), awarded: expect.any(Boolean) }));
      expect((await http.get(api('/admin/schemes/progress')).query({ userId: 'PLM-9999' }).set('authorization', admin)).status).toBe(404);
    });

    it('exports the filtered audit log as CSV', async () => {
      const res = await http.get(api('/admin/audit-logs/export.csv')).query({ entityType: 'Scan' }).set('authorization', admin);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/csv');
      const [header, ...rows] = res.text.trim().split('\n');
      expect(header).toBe('timestamp,admin,action,entity,reference,summary');
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.includes(',Scan,'))).toBe(true);
    });

    it('exports reports as CSV', async () => {
      const res = await http.get(api('/admin/reports/points?period=all&format=csv')).set('authorization', admin);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/csv');
    });
  });
});
