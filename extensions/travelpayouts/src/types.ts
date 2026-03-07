/** Plugin configuration passed via openclaw.json plugins.entries.travelpayouts.config */
export type TravelpayoutsConfig = {
  gatewayBaseUrl: string;
};

// ---------------------------------------------------------------------------
// Flight search (Aviasales prices_for_dates)
// ---------------------------------------------------------------------------

export type FlightResult = {
  origin: string;
  destination: string;
  price: number;
  airline: string;
  flightNumber: string;
  departureAt: string;
  returnAt: string;
  transfers: number;
  link: string;
};

export type FlightApiResponse = {
  success: boolean;
  data: Array<{
    origin: string;
    destination: string;
    price: number;
    airline: string;
    flight_number: string;
    departure_at: string;
    return_at: string;
    transfers: number;
    link: string;
  }>;
};

// ---------------------------------------------------------------------------
// Hotel search (Hotellook)
// ---------------------------------------------------------------------------

export type HotelResult = {
  hotelName: string;
  stars: number;
  priceFrom: number;
  priceAvg: number;
  currency: string;
  location: { lat: number; lon: number };
  hotelId: number;
  link: string;
};

export type HotelApiResponse = Array<{
  hotelName: string;
  stars: number;
  priceFrom: number;
  priceAvg: number;
  hotelId: number;
  location: { lat: number; lon: number };
}>;

// ---------------------------------------------------------------------------
// Transfers
// ---------------------------------------------------------------------------

export type TransferResult = {
  provider: string;
  vehicleType: string;
  price: number;
  currency: string;
  duration: string;
  link: string;
};

// ---------------------------------------------------------------------------
// Trains
// ---------------------------------------------------------------------------

export type TrainResult = {
  trainNumber: string;
  departure: string;
  arrival: string;
  duration: string;
  price: number;
  currency: string;
  link: string;
};
