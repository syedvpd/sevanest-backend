# Customers & Address Management Module

## 1. Executive Summary

The **Customers Module** oversees customer profile lifecycles, service delivery addresses, and operational support interactions across SevaNest. It provides households with a seamless interface to maintain their personal contact preferences, geocoded service locations, and multiple home addresses.

Engineered around **Privacy** and **Address Integrity**:
1. **Verified Mobile Binding:** Customer identity is strictly anchored to the phone number verified during authentication, preventing unauthorized identity alteration.
2. **Default Address Resilience:** Enforces database-level invariants ensuring a customer always has at most one designated primary service address for on-demand bookings.
3. **Data Protection & Masking:** Sensitive customer contact information is masked in routine administrative queues to protect user privacy.

---

## 2. Core Features & Capabilities

* **Customer Profile Lifecycle:** Manages customer names, email notifications, and communication language preferences (e.g., Telugu, Hindi, English).
* **Multiple Address Book:** Allows customers to save multiple household addresses (e.g., "Home", "Parents' Home", "Office") with optional GPS coordinates.
* **Smart Default Address:** Instant selection and switching of primary service addresses with atomic database-level uniqueness enforcement.
* **Soft Deactivation:** Preserves historical address integrity—deleting an address soft-deactivates it so completed and active bookings retain accurate physical records.
* **Customer Support Notes:** Allows operations and customer care staff to attach internal service notes and timeline comments to customer profiles.

---

## 3. End-to-End Customer Profile Workflow

The following diagram illustrates how customer profiles and service addresses are established:

```
Customer Mobile App (Flutter)
           │
           ▼
[POST /api/v1/customers/me { name, email, preferredLanguage }]
           │
           ▼
┌────────────────────────────────────────────────────────┐
│ 1. Profile Creation & Constraint Check                 │
│    - Verifies customer does not already have a profile │
│    - Links record directly to authenticated userId     │
│    - Sets initial verification status to PENDING       │
└──────────────────────────┬─────────────────────────────┘
                           │
                           ▼
[POST /api/v1/customers/me/addresses { line, area, city, pincode, isDefault }]
                           │
                           ▼
┌────────────────────────────────────────────────────────┐
│ 2. Address Provisioning & Default Resolution           │
│    - Validates 6-digit Indian PIN code and area        │
│    - If marked as default, atomically clears previous  │
│      default address for this customer                 │
│    - Saves address row and returns addressId           │
└────────────────────────────────────────────────────────┘
```

---

## 4. API Endpoints & Contracts

### 1. `POST /api/v1/customers/me` & `GET /api/v1/customers/me`
Creates and retrieves the authenticated customer's profile.
* **Payload:** `{ name: "Priya Sharma", email: "priya@example.com", preferredLanguage: "te" }`

---

### 2. `PATCH /api/v1/customers/me`
Updates profile contact information or language preferences.

---

### 3. `GET /api/v1/customers/me/addresses` & `POST /api/v1/customers/me/addresses`
Lists active saved addresses or registers a new service location.
* **Payload:** `{ line: "Flat 402, Sunshine Heights", area: "Kondapur", city: "Hyderabad", pincode: "500084", isDefault: true }`

---

### 4. `PUT /api/v1/customers/me/addresses/:addressId/default`
Designates an existing address as the customer's primary default location.

---

### 5. `DELETE /api/v1/customers/me/addresses/:addressId`
Soft-deactivates a saved address from the customer's active address list.

---

### 6. `GET /api/v1/admin/customers` & `GET /api/v1/admin/customers/:customerId`
Allows authorized operations staff to view customer directories and inspect address histories with masked phone numbers.

---

## 5. Inter-Module Dependencies & System Design

The Customers module collaborates with identity and transaction domains:

```
┌─────────────────────────┐
│       Auth Module       │──┐
│   (User Verification)   │  │
└─────────────────────────┘  │
┌─────────────────────────┐  │
│      Users Module       │──┼──► [ Customers Module ] ──► [ Booking Module ]
│  (Account & Suspension) │  │    (Profiles & Addresses)   (Service Location)
└─────────────────────────┘  │
┌─────────────────────────┐  │
│   Service Area Module   │──┘
│ (Valid Service Zones)   │
└─────────────────────────┘
```

* **Booking Integration:** When a booking is initiated, the Booking module references the customer's active address to verify that service delivery is within an enabled operational zone.
* **Lifecycle Governance:** Account-level suspensions initiated in the Users module immediately cut off access to customer profile and address mutation endpoints.

