#ifndef DSH_IOS_SDK_SHIM_MACH_VM_H_
#define DSH_IOS_SDK_SHIM_MACH_VM_H_
/*
 * The public iOS SDK ships <mach/mach_vm.h> as an unsupported stub, but iOS
 * libSystem does export these at runtime. Declare the ones this port needs so
 * V8's code can compile and link against the iOS SDK.
 *
 * Verified on-device (iPhone 15 / iOS 17.1.1): mach_vm_remap and mach_vm_protect
 * both return KERN_SUCCESS, and a second mapping of the same physical pages can
 * be made executable while the original stays writable.
 *
 * Passed to the build with -I; see build-node-ios.sh.
 */
#include <mach/mach_types.h>
#include <mach/memory_object_types.h>
#include <mach/vm_inherit.h>
#include <mach/vm_map.h>
#include <mach/vm_prot.h>
#include <mach/vm_types.h>

__BEGIN_DECLS

kern_return_t mach_vm_map(vm_map_t target_task,
                          mach_vm_address_t *address,
                          mach_vm_size_t size,
                          mach_vm_offset_t mask,
                          int flags,
                          mem_entry_name_port_t object,
                          memory_object_offset_t offset,
                          boolean_t copy,
                          vm_prot_t cur_protection,
                          vm_prot_t max_protection,
                          vm_inherit_t inheritance);

kern_return_t mach_vm_remap(vm_map_t target_task,
                            mach_vm_address_t *target_address,
                            mach_vm_size_t size,
                            mach_vm_offset_t mask,
                            int flags,
                            vm_map_t src_task,
                            mach_vm_address_t src_address,
                            boolean_t copy,
                            vm_prot_t *cur_protection,
                            vm_prot_t *max_protection,
                            vm_inherit_t inheritance);

/* Missing from the SDK's stub in the same way as the two above. */
kern_return_t mach_vm_protect(vm_map_t target_task,
                              mach_vm_address_t address,
                              mach_vm_size_t size,
                              boolean_t set_maximum,
                              vm_prot_t new_protection);

/* Also missing, and needed to drop an alias again. */
kern_return_t mach_vm_deallocate(vm_map_t target,
                                 mach_vm_address_t address,
                                 mach_vm_size_t size);

__END_DECLS

#endif /* DSH_IOS_SDK_SHIM_MACH_VM_H_ */
