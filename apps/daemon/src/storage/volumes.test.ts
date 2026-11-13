import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { listVolumes, parseMountInfo, scannableMounts } from "./volumes.ts";

// A daemon's view under systemd ProtectSystem=strict + ProtectHome=true, with docker
// layers, a boot partition, a second disk (also bind-mounted by a subdir) whose mount point needs escaping.
const MOUNTINFO = [
  "792 638 9:2 / / ro,relatime shared:648 master:1 - ext4 /dev/md2 rw",
  "793 792 0:5 / /dev rw,nosuid,relatime shared:649 master:2 - devtmpfs udev rw,size=32383932k",
  "795 793 0:27 / /dev/shm rw,nosuid,nodev shared:651 master:4 - tmpfs tmpfs rw,inode64",
  "798 792 0:25 / /run rw,nosuid,nodev,noexec,relatime shared:655 master:5 - tmpfs tmpfs rw,size=6492816k",
  "803 792 0:22 / /sys rw,nosuid,nodev,noexec,relatime shared:662 master:7 - sysfs sysfs rw",
  "813 792 0:23 / /proc rw,relatime shared:673 master:13 - proc proc rw",
  "816 792 9:1 / /boot ro,relatime shared:676 master:30 - ext3 /dev/md1 rw",
  "817 816 259:2 / /boot/efi ro,relatime shared:677 master:48 - vfat /dev/nvme0n1p1 rw,fmask=0077",
  "818 792 259:6 / /data ro,relatime shared:678 master:46 - ext4 /dev/nvme1n1p1 rw",
  "819 792 0:46 / /var/lib/docker/rootfs/overlayfs/3960 rw,relatime shared:679 master:341 - overlay overlay rw,lowerdir=/a",
  "821 792 9:2 /etc /etc rw,relatime shared:681 master:1 - ext4 /dev/md2 rw",
  "822 792 0:25 /systemd/inaccessible/dir /home ro,nosuid,nodev,noexec,relatime shared:682 master:5 - tmpfs tmpfs rw",
  "828 792 9:2 /tmp /tmp rw,relatime shared:684 master:1 - ext4 /dev/md2 rw",
  "829 792 9:2 /usr /usr rw,relatime shared:685 master:1 - ext4 /dev/md2 rw",
  "830 792 9:2 /var /var rw,relatime shared:686 master:1 - ext4 /dev/md2 rw",
  "840 792 8:17 / /srv/backup\\040disk rw,relatime shared:700 - xfs /dev/sdb1 rw",
  "841 792 8:17 /sub /mnt/backup-sub rw,relatime shared:701 - xfs /dev/sdb1 rw",
  "850 792 7:3 / /snap/core/123 ro,nodev,relatime shared:702 - squashfs /dev/loop3 ro",
  "garbage line",
  ""
].join("\n");

test("bind mounts of one device collapse into its shortest mount point; virtual, boot and container mounts are dropped", () => {
  const mounts = scannableMounts(parseMountInfo(MOUNTINFO));
  assert.deepEqual(
    mounts.map((mount) => [mount.mountPoint, mount.device, mount.source, mount.fsType]),
    [
      ["/", "9:2", "/dev/md2", "ext4"],
      ["/data", "259:6", "/dev/nvme1n1p1", "ext4"],
      ["/srv/backup disk", "8:17", "/dev/sdb1", "xfs"]
    ]
  );
});

test("listVolumes reads the mount table it is given and answers null space for an unmeasurable mount", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "storage-volumes-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "mountinfo");
  await writeFile(
    path,
    [
      "1 0 9:2 / / rw - ext4 /dev/md2 rw",
      `2 1 9:9 / ${dir.replaceAll(" ", "\\040")}/missing rw - ext4 /dev/sdz rw`
    ].join("\n")
  );
  const volumes = await listVolumes(path);
  assert.deepEqual(
    volumes.map((volume) => volume.id),
    ["/", `${dir}/missing`]
  );
  assert.ok((volumes[0]!.totalBytes ?? 0) > 0);
  assert.ok(volumes[0]!.usedBytes! <= volumes[0]!.totalBytes!);
  assert.deepEqual(
    [volumes[1]!.totalBytes, volumes[1]!.usedBytes, volumes[1]!.freeBytes],
    [null, null, null]
  );
});
