import type { ProductCategory, UserRole } from '../../../common/domain/enums.js';

export type ParticipantRole = Exclude<UserRole, 'admin'>;
export type StockLevel = 'In Stock' | 'Low Stock';

/** Product row as read for Explore (active products only). */
export interface ExploreProductRowBo {
  id: string;
  name: string;
  modelCode: string;
  category: ProductCategory;
  description: string;
  dimensions: string | null;
  features: string[];
  imageUrl: string | null;
  mrp: number;
  plumberPoints: number;
  rewardEligible: boolean;
  dealersInStock: number;
}

export interface LiveSchemeBo {
  id: string;
  name: string;
  description: string;
  eligibleCategories: ProductCategory[];
  targetValue: number;
  incentivePoints: number;
  endDate: Date;
}

/** What the caller earns from a product, for their role. */
export interface EarningBo {
  points: number;
  basis: 'per approved scan' | 'per unit sold at MRP';
  schemes: Array<Pick<LiveSchemeBo, 'id' | 'name' | 'incentivePoints' | 'targetValue' | 'endDate'>>;
}

export interface ExploreProductBo extends Omit<ExploreProductRowBo, 'mrp' | 'plumberPoints' | 'dealersInStock'> {
  earning: EarningBo;
  /** Plumbers only: dealers reporting it in stock. Retailers never see other shops' stock. */
  dealersInStock: number | null;
  /** Retailers only: catalogue price (what their orders are priced at). */
  listPrice: number | null;
}

export interface DealerRowBo {
  id: string;
  shopName: string;
  address: string;
  city: string;
  state: string;
  mobile: string;
  /** Upload key (image ID) of the shop front photo. */
  shopPhotoKey: string | null;
  sameCity: boolean;
}

export interface DealerStockBo extends DealerRowBo {
  quantity: number;
  stockLevel: StockLevel;
  updatedAt: Date;
}

export interface DealerSummaryBo extends DealerRowBo {
  productsInStock: number;
}

export interface DealerProductBo extends ExploreProductBo {
  quantity: number;
  stockLevel: StockLevel;
}

export interface ExploreQueryBo {
  page: number;
  pageSize: number;
  search?: string;
  category?: ProductCategory;
}
