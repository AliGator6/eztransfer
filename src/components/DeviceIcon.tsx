import React from 'react';
import { Laptop, Monitor, Smartphone } from 'lucide-react';
import type { DeviceType } from '../types/transfer';

interface DeviceIconProps {
  type: DeviceType;
  className?: string;
}

export const DeviceIcon: React.FC<DeviceIconProps> = ({ type, className = 'w-5 h-5' }) => {
  if (type === 'android' || type === 'ios') {
    return <Smartphone className={className} aria-hidden="true" />;
  }
  if (type === 'mac') {
    return <Laptop className={className} aria-hidden="true" />;
  }
  return <Monitor className={className} aria-hidden="true" />;
};
