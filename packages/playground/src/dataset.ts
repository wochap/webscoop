export interface Product {
  id: string;
  title: string;
  /** Price in US dollars. */
  price: number;
  /** Site-relative product page URL. */
  url: string;
  /** Site-relative image URL. */
  image: string;
  /** Rating out of 5. */
  rating: number;
  category: string;
  /** Seller name, cycling a fixed list by dataset index. */
  seller: string;
}

const CATEGORY = 'Electronics';
const SELLERS = ['Acme', 'Northwind', 'Globex', 'Initech'] as const;

const rows: [title: string, price: number, rating: number][] = [
  ['Wireless Mouse', 24.99, 4.5],
  ['Mechanical Keyboard', 89.0, 4.7],
  ['USB-C Hub', 34.5, 4.1],
  ['27-inch Monitor', 1299.0, 4.6],
  ['Noise Cancelling Headphones', 249.99, 4.8],
  ['Webcam 1080p', 59.95, 3.9],
  ['Portable SSD 1TB', 119.0, 4.7],
  ['Laptop Stand', 29.99, 4.3],
  ['Bluetooth Speaker', 45.0, 4.2],
  ['Smart Watch', 199.0, 4.0],
  ['Wireless Charger', 19.99, 3.8],
  ['Gaming Headset', 79.5, 4.4],
  ['Desk Lamp', 39.0, 4.5],
  ['Ergonomic Chair', 349.0, 4.6],
  ['HDMI Cable 2m', 9.99, 4.2],
  ['Graphics Tablet', 129.0, 4.3],
  ['Mesh Wi-Fi Router', 229.0, 4.4],
  ['Microphone', 99.0, 4.6],
  ['E-Reader', 139.99, 4.7],
  ['Action Camera', 279.0, 4.1],
  ['Power Bank 20000mAh', 49.99, 4.5],
  ['Smart Plug', 14.99, 4.0],
  ['Fitness Tracker', 69.0, 3.7],
  ['Drawing Pen Set', 12.5, 4.9],
];

/** The 24 products every tier renders. Ground truth for tests. */
export const dataset: readonly Product[] = Object.freeze(
  rows.map(([title, price, rating], i) => {
    const id = `p${String(i + 1).padStart(2, '0')}`;
    return Object.freeze({
      id,
      title,
      price,
      url: `/p/${id}`,
      image: `/img/${id}.svg`,
      rating,
      category: CATEGORY,
      seller: SELLERS[i % SELLERS.length]!,
    });
  }),
);
