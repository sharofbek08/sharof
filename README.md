# Satrlarim

Vue frontend, Node.js API va lokal PostgreSQL bazasi.

## Lokal ishga tushirish

1. Node.js va Docker Desktop o‘rnatilgan bo‘lsin.
2. `backend/.env.example` faylini `backend/.env` nomi bilan nusxalang. `JWT_SECRET` qiymatini o‘zingizga mos uzun tasodifiy qiymatga almashtiring.
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

## Bulut PostgreSQL-д холбох

Lokal Docker bazasi faqat ishlab chiqish uchun. Doimiy bulut xotirasi uchun managed PostgreSQL xizmatidan connection URL oling va uni backend ishlaydigan hostingdagi maxfiy environment variables ichiga qo‘ying:

- `DATABASE_URL` — cloud PostgreSQL connection string
- `DATABASE_SSL=true` — TLS ulanish
- `JWT_SECRET` — uzun, tasodifiy, maxfiy qiymat
- `HOST=0.0.0.0` — hosting tashqi so‘rovlarni qabul qilishi uchun
- `PORT` — hosting bergan port

Backendni `npm run build`dan keyin `npm run start:api` bilan ishga tushiring. Backend ishga tushganda `backend/schema.sql` jadvalni yaratadi.

Frontend backend bilan bir hostingda bo‘lsa, qo‘shimcha URL kerak emas. Frontend alohida hostingda bo‘lsa, build vaqtida `VITE_API_BASE_URL=https://api.example.com/api` ni, backendda esa `WEB_ORIGIN=https://site.example.com` ni sozlang. `.env` yoki cloud connection URL’ni Git’ga qo‘shmang.
