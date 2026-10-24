import { Injectable } from '@nestjs/common';
import { AppException } from '../../../common/errors/app.exception.js';
import type { Page } from '../../../common/dto/pagination.dto.js';
import { SettingsService } from '../../settings/services/settings.service.js';
import type {
  DealerProductBo,
  DealerStockBo,
  DealerSummaryBo,
  DealerRowBo,
  EarningBo,
  ExploreProductBo,
  ExploreProductRowBo,
  ExploreQueryBo,
  LiveSchemeBo,
  ParticipantRole,
  StockLevel,
} from '../bo/explore.bo.js';
import { ExploreRepository } from '../repositories/explore.repository.js';

interface Caller {
  id: string;
  role: ParticipantRole;
}

/** Earning rules shared by every Explore view, resolved once per request. */
interface EarningContext {
  role: ParticipantRole;
  rate: number;
  threshold: number;
  schemes: LiveSchemeBo[];
}

/**
 * Explore: which products earn what, and which nearby dealers have them in stock.
 * Points follow the same rules as approvals — plumbers earn the product's scan points; retailers earn
 * the invoice incentive (rate per ₹100 of value), shown per unit at MRP.
 */
@Injectable()
export class ExploreService {
  constructor(
    private readonly explore: ExploreRepository,
    private readonly settings: SettingsService,
  ) {}

  async products(caller: Caller, query: ExploreQueryBo): Promise<Page<ExploreProductBo>> {
    const [page, ctx] = await Promise.all([this.explore.productPage(query), this.context(caller.role)]);
    return { ...page, items: page.items.map((row) => this.withEarning(row, ctx)) };
  }

  async product(caller: Caller, id: string): Promise<{ product: ExploreProductBo; dealers: DealerStockBo[]; city: string | null }> {
    const [row, city, ctx] = await Promise.all([this.explore.product(id), this.explore.cityOf(caller.id), this.context(caller.role)]);
    if (!row) throw AppException.notFound('Product', id);
    const dealers = caller.role === 'plumber' ? await this.explore.dealersForProduct(id, city) : [];
    return {
      product: this.withEarning(row, ctx),
      dealers: dealers.map((d) => ({ ...d, stockLevel: this.level(d.quantity, ctx.threshold) })),
      city,
    };
  }

  async dealers(caller: Caller, search?: string): Promise<{ dealers: DealerSummaryBo[]; city: string | null }> {
    const city = await this.explore.cityOf(caller.id);
    return { dealers: await this.explore.dealers(search, city), city };
  }

  async dealer(caller: Caller, id: string): Promise<{ dealer: DealerRowBo; products: DealerProductBo[] }> {
    const city = await this.explore.cityOf(caller.id);
    const [dealer, rows, ctx] = await Promise.all([this.explore.dealer(id, city), this.explore.dealerProducts(id), this.context(caller.role)]);
    if (!dealer) throw AppException.notFound('Dealer', id);
    return {
      dealer,
      products: rows.map((row) => ({ ...this.withEarning(row, ctx), quantity: row.quantity, stockLevel: this.level(row.quantity, ctx.threshold) })),
    };
  }

  private async context(role: ParticipantRole): Promise<EarningContext> {
    const [settings, schemes] = await Promise.all([this.settings.get(), this.explore.liveSchemes(role)]);
    return { role, rate: settings.retailerPointsPer100, threshold: settings.lowStockThreshold, schemes };
  }

  private withEarning({ mrp, plumberPoints, dealersInStock, ...row }: ExploreProductRowBo, ctx: EarningContext): ExploreProductBo {
    const eligible = row.rewardEligible;
    const earning: EarningBo =
      ctx.role === 'plumber'
        ? { points: eligible ? plumberPoints : 0, basis: 'per approved scan', schemes: [] }
        : { points: eligible ? Math.floor((mrp / 100) * ctx.rate) : 0, basis: 'per unit sold at MRP', schemes: [] };
    earning.schemes = eligible
      ? ctx.schemes
          .filter((s) => s.eligibleCategories.includes(row.category))
          .map(({ id, name, incentivePoints, targetValue, endDate }) => ({ id, name, incentivePoints, targetValue, endDate }))
      : [];
    // Other shops' stock is only useful to plumbers deciding where to buy; retailers see their price instead.
    return ctx.role === 'plumber' ? { ...row, earning, dealersInStock, listPrice: null } : { ...row, earning, dealersInStock: null, listPrice: mrp };
  }

  private level(quantity: number, threshold: number): StockLevel {
    return quantity <= threshold ? 'Low Stock' : 'In Stock';
  }
}
