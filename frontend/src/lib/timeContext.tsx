'use client'

import React, { createContext, useContext, useEffect, useState, ReactNode } from 'react'

interface TimeContextType {
  tick: number
}

const TimeContext = createContext<TimeContextType>({ tick: Date.now() })

export const useTime = () => useContext(TimeContext)

interface TimeProviderProps {
  children: ReactNode
  intervalMs?: number
}

export const TimeProvider: React.FC<TimeProviderProps> = ({ 
  children, 
  intervalMs = 30000 
}) => {
  const [tick, setTick] = useState(Date.now())

  useEffect(() => {
    const interval = setInterval(() => {
      setTick(Date.now())
    }, intervalMs)

    return () => clearInterval(interval)
  }, [intervalMs])

  return (
    <TimeContext.Provider value={{ tick }}>
      {children}
    </TimeContext.Provider>
  )
}
