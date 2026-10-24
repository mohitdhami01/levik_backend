import { ApiProperty } from '@nestjs/swagger';
import { PRODUCT_CATEGORIES, type ProductCategory } from '../../../common/domain/enums.js';

export class ExploreSchemeDto {
  id: string;
  name: string;
  /** One-time bonus on reaching the scheme target. */
  incentivePoints: number;
  /** Approved scans (plumbers) or ₹ of eligible sales (retailers). */
  targetValue: number;
  endDate: string;
}

export class ExploreEarningDto {
  /** Points the caller earns from this product (0 if not reward-eligible). */
  points: number;
  @ApiProperty({ enum: ['per approved scan', 'per unit sold at MRP'] })
  basis: 'per approved scan' | 'per unit sold at MRP';
  /** Live schemes for the caller's role that count this product. */
  schemes: ExploreSchemeDto[];
}

export class ExploreProductDto {
  id: string;
  name: string;
  modelCode: string;
  @ApiProperty({ enum: PRODUCT_CATEGORIES })
  category: ProductCategory;
  description: string;
  dimensions?: string;
  features: string[];
  imageUrl?: string;
  rewardEligible: boolean;
  /** Plumbers only: approved, active dealers reporting this product in stock. */
  dealersInStock?: number;
  /** Retailers only: catalogue price (MRP) their stock orders are priced at. */
  listPrice?: number;
  earning: ExploreEarningDto;
}

export class ExploreProductPageDto {
  items: ExploreProductDto[];
  total: number;
  page: number;
  pageSize: number;
}

export class ExploreDealerDto {
  id: string;
  shopName: string;
  address: string;
  city: string;
  state: string;
  mobile: string;
  /** Signed link to the shop front photo, relative to the API origin. */
  shopPhotoUrl?: string;
  /** Dealer is in the caller's city ("nearby"). */
  sameCity: boolean;
}

export class ExploreDealerStockDto extends ExploreDealerDto {
  quantity: number;
  @ApiProperty({ enum: ['In Stock', 'Low Stock'] })
  stockLevel: 'In Stock' | 'Low Stock';
  updatedAt: string;
}

export class ExploreProductDetailDto {
  product: ExploreProductDto;
  /** Plumbers only (empty for retailers): dealers with this product in stock, caller's city first, then most stock. */
  dealers: ExploreDealerStockDto[];
  /** Caller's city used for "nearby" ordering. */
  city?: string;
}

export class ExploreDealerSummaryDto extends ExploreDealerDto {
  productsInStock: number;
}

export class ExploreDealerListDto {
  dealers: ExploreDealerSummaryDto[];
  city?: string;
}

export class ExploreDealerProductDto extends ExploreProductDto {
  quantity: number;
  @ApiProperty({ enum: ['In Stock', 'Low Stock'] })
  stockLevel: 'In Stock' | 'Low Stock';
}

export class ExploreDealerDetailDto {
  dealer: ExploreDealerDto;
  products: ExploreDealerProductDto[];
}
