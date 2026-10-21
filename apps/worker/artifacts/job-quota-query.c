#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <linux/fs.h>
#include <linux/magic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/quota.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <unistd.h>

#ifndef PRJQUOTA
#define PRJQUOTA 2
#endif

struct ext4_uuid_header { uint32_t length; uint32_t flags; };
struct ext4_uuid_query { struct ext4_uuid_header header; unsigned char bytes[16]; };

/* Project quotas clamp statfs within a project; volume geometry belongs to the mount root. */
static int filesystem_capacity(int directory, struct statfs *output) {
  int current = dup(directory);
  if (current < 0) return -1;
  for (;;) {
    struct statx here;
    struct statx above;
    int parent = openat(current, "..", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (parent < 0) {
      int error = errno;
      close(current);
      errno = error;
      return -1;
    }
    if (statx(current, "", AT_EMPTY_PATH, STATX_INO | STATX_MNT_ID, &here)
        || statx(parent, "", AT_EMPTY_PATH, STATX_INO | STATX_MNT_ID, &above)) {
      int error = errno;
      close(parent);
      close(current);
      errno = error;
      return -1;
    }
    if (here.stx_mnt_id != above.stx_mnt_id || here.stx_ino == above.stx_ino) {
      int result = fstatfs(current, output);
      int error = errno;
      close(parent);
      close(current);
      errno = error;
      return result;
    }
    close(current);
    current = parent;
  }
}

static int filesystem_uuid(int directory, char *output) {
  unsigned char bytes[16];
#ifdef FS_IOC_GETFSUUID
  struct fsuuid2 observed = {0};
  if (ioctl(directory, FS_IOC_GETFSUUID, &observed) == 0) {
    if (observed.len != 16) { errno = EINVAL; return -1; }
    memcpy(bytes, observed.uuid, 16);
  } else {
    if (errno != ENOTTY && errno != EOPNOTSUPP) return -1;
#endif
    struct ext4_uuid_query legacy = { .header = { .length = 16, .flags = 0 } };
    if (ioctl(directory, _IOR('f', 44, struct ext4_uuid_header), &legacy) != 0
        || legacy.header.length != 16) return -1;
    memcpy(bytes, legacy.bytes, 16);
#ifdef FS_IOC_GETFSUUID
  }
#endif
  snprintf(output, 37,
    "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
    bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
    bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]);
  return 0;
}

/* This observer has no provisioning or quota mutation operations. */
int main(int argc, char **argv) {
  if (argc != 3 || argv[1][0] != '/' || argv[2][0] != '/') return 2;
  int directory = open(argv[1], O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (directory < 0) { perror("open quota directory"); return 1; }
  struct stat directory_stat, device_stat;
  struct statfs filesystem;
  struct statx extended;
  struct fsxattr project;
  struct dqblk quota;
  struct dqinfo info;
  char uuid[37];
  if (fstat(directory, &directory_stat) || stat(argv[2], &device_stat)
      || !S_ISBLK(device_stat.st_mode) || device_stat.st_rdev != directory_stat.st_dev
      || filesystem_capacity(directory, &filesystem) || filesystem.f_type != EXT4_SUPER_MAGIC
      || statx(directory, "", AT_EMPTY_PATH, STATX_MNT_ID, &extended)
      || ioctl(directory, FS_IOC_FSGETXATTR, &project)
      || filesystem_uuid(directory, uuid)
      || quotactl(QCMD(Q_GETINFO, PRJQUOTA), argv[2], 0, (void *)&info)
      || quotactl(QCMD(Q_GETQUOTA, PRJQUOTA), argv[2], project.fsx_projid, (void *)&quota)) {
    perror("read project quota"); close(directory); return 1;
  }
  printf("{\"filesystemUuid\":\"%s\",\"volumeCapacityBytes\":%" PRIu64 ",\"volumeCapacityInodes\":%" PRIu64 ",\"projectId\":%u,\"inheritance\":%s,\"hardLimitBytes\":%" PRIu64
    ",\"hardInodes\":%" PRIu64 ",\"usedBytes\":%" PRIu64 ",\"usedInodes\":%" PRIu64
    ",\"accountingEnabled\":true,\"filesystem\":{\"device\":\"%" PRIu64
    "\",\"inode\":\"%" PRIu64 "\",\"mountId\":\"%" PRIu64 "\"}}\n",
    uuid, (uint64_t)filesystem.f_blocks * filesystem.f_bsize, (uint64_t)filesystem.f_files,
    project.fsx_projid, (project.fsx_xflags & FS_XFLAG_PROJINHERIT) ? "true" : "false",
    (uint64_t)quota.dqb_bhardlimit * 1024, (uint64_t)quota.dqb_ihardlimit,
    (uint64_t)quota.dqb_curspace, (uint64_t)quota.dqb_curinodes,
    (uint64_t)directory_stat.st_dev, (uint64_t)directory_stat.st_ino,
    (uint64_t)extended.stx_mnt_id);
  close(directory);
  return 0;
}
