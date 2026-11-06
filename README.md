# Satrlarim

Vue frontend, Node.js API va lokal PostgreSQL bazasi.

## Lokal ishga tushirish

1. Node.js va Docker Desktop o‘rnatilgan bo‘lsin.
2. `.env.example` faylini `.env` nomi bilan nusxalang. `JWT_SECRET` qiymatini o‘zingizga mos uzun tasodifiy qiymatga almashtiring.
3. PostgreSQL bazasini ishga tushiring:

   ```powershell
   npm.cmd run db:up
   ```

4. Bog‘liqliklarni o‘rnating:

   ```powershell
   npm.cmd install
   ```

5. Ikki terminal oching. Birinchisida backendni, ikkinchisida frontendni ishga tushiring:

   ```powershell
   npm.cmd run dev:api
   ```

   ```powershell
   npm.cmd run dev
   ```

Frontend `http://localhost:5173`, API `http://127.0.0.1:3000` manzilda ishlaydi.

Backend jadvalni birinchi ishga tushganda `backend/schema.sql` orqali yaratadi. PostgreSQL ma’lumotlari Docker volume’da saqlanadi.

Brauzerda avval saqlangan, Firebase’dan tashqari lokal yozuvlar birinchi ulanishda PostgreSQL’ga ko‘chiriladi. Firebase’dagi bulut yozuvlari avtomatik ko‘chmaydi; eski Firebase bazasi o‘chirilmaydi.

## Build

```powershell
npm.cmd run build
```

Build-ийн дараа frontend `frontend/dist` дотор үүснэ. Backend-ийг `npm.cmd run start:api` командаар асаахад тэр build-ийг API-тай нэг origin дээр гаргаж өгнө.
