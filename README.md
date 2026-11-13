# Vidsnap

Herhangi bir sitedeki (YouTube, X, Instagram, Reddit, forumlar…) videoya bir **indir butonu** ekler. Videonun tüm çözünürlüklerini **MP4** olarak, ya da sadece sesini **MP3** olarak indirir. İndirme ilerlemesi butonda görünür. İndirmeyi duraklatabilir, devam ettirebilir ya da iptal edebilirsin.

## Kurulum (Windows)

1. [Releases](https://github.com/berkaygulerr/vidsnap/releases/latest) sayfasından **`Vidsnap_x.y.z_x64-setup.exe`** dosyasını indirip çalıştır.
2. Vidsnap açılınca gerekli araçları (yt-dlp, ffmpeg) kendisi indirir.
3. **Eklentiyi kur** düğmesine bas. Sihirbaz eklentiyi Chrome, Brave ya da Edge'e kendisi yükler.

Uygulama ve eklenti yeni sürümlerde **kendini otomatik günceller**.

## Proje yapısı

```
extension/          Tarayıcı eklentisi (buton, menü, ağdan video akışı yakalama)
desktop/host/       Yerel yardımcı (Rust): indirmeyi yt-dlp + ffmpeg ile yapar
desktop/app/        Masaüstü uygulaması (Tauri 2): tepsi, geçmiş, ayarlar, eklenti sihirbazı, güncelleme
yayinla.ps1         Yeni sürümü derleyip imzalar ve GitHub Releases'a yükler
host/, install.ps1  Eski Node tabanlı kurulum (artık gerekmiyor)
```

## Nasıl çalışır

1. Eklenti, imlecin altındaki videoyu bulur (Shadow DOM ve iframe'ler dahil).
2. Videonun adresini belirlemek için sırayla şunlara bakar:
   - Bilinen sitelerde gönderinin kendi linki
   - `<video>` etiketindeki doğrudan dosya
   - Ağ trafiğinden yakalanan `.m3u8` / `.mpd` / `.mp4` akışları
3. yt-dlp kaliteleri listeler. Seçilen kalite indirilir ve MP4 olarak birleştirilir (mümkünse H.264 + AAC).
4. Giriş gerektiren siteler için o sitenin çerezleri yalnızca yerel yardımcıya aktarılır.

## Sürüm yayınlama

```
.\yayinla.ps1 -Surum 0.2.2 -Notlar "Değişiklikler"
```

İmza anahtarı `%USERPROFILE%\.vidsnap\updater.key` dosyasındadır. Bu dosya repoda yoktur, yedeklenmelidir.

## Sınırlar

- DRM korumalı platformlar (Netflix, Disney+, Spotify vb.) desteklenmez.
- Kişisel kullanım içindir.
