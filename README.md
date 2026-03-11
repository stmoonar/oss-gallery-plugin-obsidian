# Obsidian OSS Gallery Plugin

### English | [中文](./README-zh.md)

This repository is forked from [Obsidian Minio Uploader Plugin](https://github.com/seebin/obsidian-minio-uploader-plugin) and extended with multi-provider support and new features.

## Supported Providers
- **MinIO** — Self-hosted S3-compatible object storage
- **SM.MS** — Free image hosting
- **GitHub** — Upload to GitHub repository
- **Aliyun OSS** — Alibaba Cloud Object Storage Service
- **Tencent COS** — Tencent Cloud Object Storage
- **Qiniu Kodo** — Qiniu Cloud Storage
- **Upyun USS** — Upyun Cloud Storage
- **Imgur** — Anonymous image hosting

## Features
- Supports dragging and dropping files to the editor and directly uploading them to your configured provider
- Support for directly uploading files after pasting them into the editor
- Command palette file upload (supports image, video, audio, and document files)
- Support preview for various file types:
  - Image preview
  - Video preview
  - Audio preview
  - Document preview (Google Docs/Office Online)
- Image gallery view:
  - View all uploaded images in a grid layout
  - Search images by URL (supports regex and wildcard patterns)
  - Copy image URL with one click
  - Delete images directly from the gallery
  - Preview images in full screen
- Smart gallery optimization:
  - LRU caching strategy for improved performance
  - Lazy loading with Intersection Observer
  - Back to top button
  - Batch rendering optimization
  - Memory management and cleanup
- Enhanced image preview:
  - Smooth animations with hardware acceleration
  - Click background to close
  - ESC key to exit
  - Optimized drag performance

![upload](./upload.gif)
---
![delete](./delete.gif)

## Setting

Select your preferred storage provider in the plugin settings, then configure the corresponding provider settings.

### MinIO

> Tip: Port is the API data access port for MinIO

- accessKey
- secretKey
- bucket
- endpoint
- port
- SSL
- Custom domain (Optional)

You also need to enable anonymous file access in the MinIO console Bucket settings so files can be accessed directly via URL.

![Settings](./minio-bucket-setting.png)

### SM.MS
- API Token

### GitHub
- Repository (format: `owner/repo`)
- Branch
- Token (Personal Access Token)
- Custom URL (Optional, for CDN like jsDelivr)

### Aliyun OSS
- Access Key ID
- Access Key Secret
- Bucket
- Region (e.g., `oss-cn-hangzhou`)
- Path prefix (Optional)
- Custom domain (Optional, for CDN)

### Tencent COS
- Secret ID
- Secret Key
- Bucket
- Region (e.g., `ap-shanghai`)
- Path prefix (Optional)
- Custom domain (Optional)

### Qiniu Kodo
- Access Key
- Secret Key
- Bucket
- CDN domain URL
- Storage area
- Path prefix (Optional)

### Upyun USS
- Operator name
- Password
- Service name (Bucket)
- Acceleration domain URL
- Path prefix (Optional)
- Image processing suffix (Optional)

### Imgur
- Client ID
- Proxy URL (Optional, required in some regions)
